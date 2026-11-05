#!/bin/sh
set -eu
profile=''
version=latest
dsh=dsh
fail() { printf '%s\n' "dsh-bot install: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile|--version|--dsh)
      [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1"
      case "$1" in --profile) profile=$2;; --version) version=$2;; --dsh) dsh=$2;; esac
      shift 2;;
    --help) printf '%s\n' 'Usage: sh install.sh --profile NAME [--version latest|0.10.0] [--dsh PATH]'; exit 0;;
    *) fail "Unknown option: $1";;
  esac
done
case "$profile" in ''|[!A-Za-z0-9]*|*[!A-Za-z0-9_.-]*) fail 'An explicit valid --profile is required';; esac
command -v "$dsh" >/dev/null 2>&1 || fail "DSH executable not found: $dsh"
command -v curl >/dev/null 2>&1 || fail 'curl is required'
command -v node >/dev/null 2>&1 || fail 'Node.js is required'
if [ "$version" = latest ]; then
  # Resolve once so the archive and checksum always belong to the same release.
  version=$(curl -fLsS https://api.github.com/repos/reina0721/dsh-bot/releases/latest | node -e '
    let s=""; process.stdin.on("data",c=>s+=c); process.stdin.on("end",()=>{
      try { const t=JSON.parse(s).tag_name; if(!/^v\d+\.\d+\.\d+$/.test(t))throw Error(); console.log(t) }
      catch { console.error("Unable to resolve latest stable release"); process.exitCode=1 }
    })') || fail 'Unable to resolve latest release'
fi
version=${version#v}
node -e 'if(!/^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$/.test(process.argv[1]))process.exit(1)' "$version" || fail 'Invalid release version'
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/dsh-bot-install.XXXXXXXX")
trap 'rm -rf "$temp_dir"' EXIT
trap 'exit 1' HUP INT TERM
base="https://github.com/reina0721/dsh-bot/releases/download/v$version"
curl -fLsS "$base/dsh-bot.tgz" -o "$temp_dir/dsh-bot.tgz" || fail 'Package download failed'
curl -fLsS "$base/SHA256SUMS" -o "$temp_dir/SHA256SUMS" || fail 'Checksum download failed'
node --input-type=module - "$temp_dir" <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const dir = process.argv[2];
const entries = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').split(/\r?\n/).filter(s => /^[a-fA-F0-9]{64}  dsh-bot\.tgz$/.test(s));
const hash = createHash('sha256').update(readFileSync(join(dir, 'dsh-bot.tgz'))).digest('hex');
if (entries.length !== 1 || entries[0].slice(0,64).toLowerCase() !== hash) {
  console.error('SHA-256 verification failed; installation stopped.'); process.exit(1);
}
NODE
cache_dir="${DSH_HOME:-$HOME/.dsh}/plugins-cache/dsh-bot/v$version"
# Keep the verified tarball: DSH's manifest retains its local path.
node --input-type=module - "$temp_dir/dsh-bot.tgz" "$cache_dir" <<'NODE'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const data = readFileSync(process.argv[2]), dir = process.argv[3];
mkdirSync(dir, { recursive: true });
const target = join(dir, 'dsh-bot.tgz');
try { writeFileSync(target, data, { flag: 'wx' }); }
catch (error) {
  if (error.code !== 'EEXIST' || !readFileSync(target).equals(data)) throw new Error('Cached release differs; refusing to replace an installed version.');
}
NODE
"$dsh" plugin --profile "$profile" add "$cache_dir/dsh-bot.tgz" || fail 'DSH installation failed'
printf '%s\n' "Installed dsh-bot v$version in profile $profile. Restart that DSH profile, then open QQ connection settings."
