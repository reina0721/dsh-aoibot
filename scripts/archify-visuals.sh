#!/usr/bin/env bash
# Regenerate the Archify visual baseline in docs/visuals.
#
# Requirements:
#   - @tt-a1i/archify-dsh installed in the current DSH profile (or ARCHIFY_SKILL set)
#   - Chrome/Chromium for the browser gate (ARCHIFY_CHROME); without it finalize
#     still writes HTML but exits non-zero at browser-check.
#
# Usage:
#   bash scripts/archify-visuals.sh                 # all diagrams
#   bash scripts/archify-visuals.sh --only roadmap  # one diagram by slug
#
# Environment (all optional):
#   ARCHIFY_SKILL                     skill root (contains bin/archify.mjs)
#   ARCHIFY_CHROME                    Chrome/Chromium executable
#   ARCHIFY_CHROME_NO_SANDBOX=1       add --no-sandbox (containers without userns)
#   ARCHIFY_SYSROOT                   prefix containing lib/ and fonts for LD_LIBRARY_PATH
#   DSH_HOME / DSH_PROFILE            profile lookup (default ~/.dsh, web)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SKILL="${ARCHIFY_SKILL:-${DSH_HOME:-$HOME/.dsh}/profiles/${DSH_PROFILE:-web}/node_modules/@tt-a1i/archify-dsh/skills/archify}"
CLI="$SKILL/bin/archify.mjs"

if [[ ! -f "$CLI" ]]; then
  echo "archify: skill not found at $SKILL" >&2
  echo "install it with: dsh plugin --profile ${DSH_PROFILE:-web} add @tt-a1i/archify-dsh@1.0.0" >&2
  exit 1
fi

if [[ -n "${ARCHIFY_SYSROOT:-}" ]]; then
  export LD_LIBRARY_PATH="$ARCHIFY_SYSROOT/usr/lib/x86_64-linux-gnu:$ARCHIFY_SYSROOT/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
  export FONTCONFIG_PATH="${FONTCONFIG_PATH:-$ARCHIFY_SYSROOT/etc/fonts}"
  export FONTCONFIG_FILE="${FONTCONFIG_FILE:-$FONTCONFIG_PATH/fonts.conf}"
fi

only=""
if [[ "${1:-}" == "--only" ]]; then
  only="${2:-}"
  if [[ -z "$only" ]]; then
    echo "usage: bash scripts/archify-visuals.sh [--only <slug>]" >&2
    exit 2
  fi
fi

shopt -s nullglob
candidates=(docs/visuals/src/*.json)
if (( ${#candidates[@]} == 0 )); then
  echo "archify: no candidates in docs/visuals/src" >&2
  exit 1
fi

pass=0
fail=0
for candidate in "${candidates[@]}"; do
  info="$(node -e '
    const fs = require("node:fs")
    const p = process.argv[1]
    const d = JSON.parse(fs.readFileSync(p, "utf8"))
    const out = d?.meta?.output || ""
    const slug = out.split("/").pop().replace(/\.html$/i, "")
    process.stdout.write([d.diagram_type || "", out, slug].join("\t"))
  ' "$candidate")"
  IFS=$'\t' read -r type output slug <<< "$info"

  if [[ -z "$type" || -z "$output" || -z "$slug" ]]; then
    echo "SKIP $candidate (missing diagram_type/meta.output)" >&2
    fail=$((fail + 1))
    continue
  fi
  if [[ -n "$only" && "$slug" != "$only" ]]; then
    continue
  fi

  evidence="docs/visuals/evidence/$slug"
  case "$evidence" in
    docs/visuals/evidence/*) ;;
    *) echo "archify: refusing evidence path $evidence" >&2; exit 2 ;;
  esac
  rm -rf -- "$evidence"
  mkdir -p -- "$evidence"

  echo "==> $slug ($type)"
  set +e
  result="$(node "$CLI" finalize "$type" "$candidate" "$output" --quality showcase --json --out-dir "$evidence" 2>&1)"
  code=$?
  set -e
  if [[ $code -eq 0 && "$result" == *'"ok":true'* ]]; then
    echo "PASS $slug"
    pass=$((pass + 1))
  else
    echo "FAIL $slug (exit $code)"
    echo "$result" | tail -n 20
    fail=$((fail + 1))
  fi
done

echo
echo "archify visuals: $pass passed, $fail failed"
(( fail == 0 ))
