#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_BIN="${DSH_BIN:-dsh}"
command -v node >/dev/null || { echo 'node is required' >&2; exit 1; }
command -v curl >/dev/null || { echo 'curl is required' >&2; exit 1; }

# Never accept the caller's live DSH_HOME or plugin-data override.
scratch="$(mktemp -d "${TMPDIR:-/tmp}/dsh-bot-smoke.XXXXXX")"
export DSH_HOME="$scratch/home"
export DSH_BOT_DATA_DIR="$DSH_HOME/plugins-data/dsh-bot"
export DSH_TELEMETRY_DISABLED=1
# Profile setup may invoke DSH's package manager: allow cached packages only.
export npm_config_offline=true
export COREPACK_ENABLE_NETWORK=0
mkdir -p "$DSH_HOME"
server_pid=''
stage=preflight
stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    for ((i=0; i<50; i++)); do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=''
  fi
}
cleanup() {
  local code=$?
  trap - EXIT
  stop_server
  if ((code != 0)); then
    node --input-type=module - "$stage" "$code" <<'NODE'
console.log(JSON.stringify({ ok: false, profile: 'web', stage: process.argv[2], exitCode: Number(process.argv[3]), temporary: true }))
NODE
    # Keep stdout machine readable; omit the boot log because it contains the token.
    echo "smoke failed at $stage (exit $code); temporary profile removed" >&2
    if [[ "$stage" == init || "$stage" == install ]]; then
      cat "$scratch/$stage.log" >&2
    fi
  fi
  rm -rf -- "$scratch"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
command -v "$DSH_BIN" >/dev/null || { echo "DSH executable not found: $DSH_BIN" >&2; exit 1; }

stage=init
"$DSH_BIN" --profile web --dump-config >"$scratch/init.log" 2>&1
mkdir -p "$DSH_BOT_DATA_DIR"
printf '%s\n' '{"enabled":false}' >"$DSH_BOT_DATA_DIR/config.json"
stage=install
"$DSH_BIN" plugin --profile web add "$ROOT" >"$scratch/install.log" 2>&1

stage=boot
port="$(node --input-type=module <<'NODE'
import { createServer } from 'node:net'
const server = createServer()
server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close() })
NODE
)"
"$DSH_BIN" web --no-open --host 127.0.0.1 --port "$port" >"$scratch/boot.log" 2>&1 &
server_pid=$!
base="http://127.0.0.1:$port"
token=''
deadline=$((SECONDS + 30))
while ((SECONDS < deadline)); do
  token="$(node --input-type=module - "$scratch/boot.log" "$base" <<'NODE'
import { readFileSync } from 'node:fs'
const log = readFileSync(process.argv[2], 'utf8').replace(/\x1b\[[0-9;]*m/g, '')
for (const match of log.matchAll(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?token=[^\s<>"'\x1b]+/g)) {
  const url = new URL(match[0])
  if (url.port === new URL(process.argv[3]).port) { process.stdout.write(url.searchParams.get('token') || ''); break }
}
NODE
)"
  [[ -n "$token" ]] && break
  kill -0 "$server_pid" 2>/dev/null || { echo 'DSH exited before printing its boot URL' >&2; exit 1; }
  sleep 0.2
done
[[ -n "$token" ]] || { echo 'No tokenized boot URL within 30 seconds' >&2; exit 1; }

# Acquire any boot-token cookie; every curl request is restricted to this loopback origin.
curl_local() {
  curl --silent --show-error --fail --noproxy '*' --proto '=http' \
    --connect-timeout 2 --max-time 5 --cookie "$scratch/cookies" --cookie-jar "$scratch/cookies" "$@"
}
stage=ready
curl_local --get --data-urlencode "token=$token" "$base/" > /dev/null
deadline=$((SECONDS + 30))
until curl_local "$base/onebot-qq/api/health" >"$scratch/health.json" 2>/dev/null \
  && node --input-type=module - "$scratch/health.json" <<'NODE'
import { readFileSync } from 'node:fs'
try { if (JSON.parse(readFileSync(process.argv[2], 'utf8')).ok !== true) process.exit(1) } catch { process.exit(1) }
NODE
do
  ((SECONDS < deadline)) || { echo 'Plugin API not healthy within 30 seconds' >&2; exit 1; }
  kill -0 "$server_pid" 2>/dev/null || exit 1
  sleep 0.2
done

stage=api
for endpoint in health status config modules media/status backup upgrade; do
  curl_local "$base/onebot-qq/api/$endpoint" >"$scratch/${endpoint//\//-}.json"
done
node --input-type=module - "$scratch" "$DSH_BOT_DATA_DIR" <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const read = (name) => JSON.parse(readFileSync(`${process.argv[2]}/${name}.json`, 'utf8'))
for (const name of ['health', 'status', 'config', 'modules', 'media-status', 'backup', 'upgrade']) assert.equal(read(name).ok, true, name)
const status = read('status')
assert.equal(typeof status.version, 'string')
assert.ok(status.version.length)
assert.equal(status.dataDir, process.argv[3])
assert.equal(status.config.enabled, false)
assert.equal(read('config').config.enabled, false)
assert.equal(read('upgrade').enabled, false)
NODE

stage=backup
curl_local --header 'Content-Type: application/json' --data '{"note":"disposable-profile smoke"}' \
  "$base/onebot-qq/api/backup/create" >"$scratch/created.json"
curl_local "$base/onebot-qq/api/backup" >"$scratch/backup-after.json"
node --input-type=module - "$scratch" <<'NODE'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
const read = (name) => JSON.parse(readFileSync(`${process.argv[2]}/${name}.json`, 'utf8'))
const created = read('created'), inventory = read('backup-after')
assert.equal(created.ok, true)
assert.equal(typeof created.item?.id, 'string')
assert.ok(created.item.id.length)
assert.equal(inventory.ok, true)
assert.ok(inventory.items.some((item) => item.id === created.item.id))
writeFileSync(`${process.argv[2]}/summary.json`, JSON.stringify({
  ok: true, profile: 'web', temporary: true, version: read('status').version,
  dataDir: read('status').dataDir, enabled: false, upgradeEnabled: false,
  endpoints: ['health', 'status', 'config', 'modules', 'media/status', 'backup', 'upgrade'],
  backupId: created.item.id,
}) + '\n')
NODE
stage=shutdown
stop_server
cat "$scratch/summary.json"
