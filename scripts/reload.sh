#!/usr/bin/env bash
# Rebuild the plugin and reload it into the local OpenClaw gateway.
#
# What it does (idempotent, safe to re-run):
#   1. Ensure openclaw CLI is available.
#   2. pnpm build → refresh dist/ (the entry OpenClaw loads).
#   3. Sanity-check that dist/index.js and dist/setup-entry.js exist.
#   4. Restart the gateway so the plugin registry re-scans dist/.
#   5. Verify the plugin is loaded (openclaw plugins inspect / doctor).
#
# Usage:
#   bash scripts/reload.sh              # full: build + restart + verify
#   bash scripts/reload.sh --no-build   # skip build, only restart + verify
#   bash scripts/reload.sh --skip-verify
#   pnpm reload                         # equivalent to full run
#
# Exit codes: 0 ok, non-zero = something failed (see stderr).

set -euo pipefail

# ---------- args ----------
DO_BUILD=1
DO_VERIFY=1
for arg in "$@"; do
  case "$arg" in
    --no-build)    DO_BUILD=0 ;;
    --skip-verify) DO_VERIFY=0 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *)
      echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ---------- paths ----------
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"
cd "$REPO_ROOT"

PLUGIN_ID="openclaw-plugin-yuanbao"

# ---------- helpers ----------
say()  { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

command -v openclaw >/dev/null 2>&1 \
  || die "openclaw CLI not found in PATH. Install: npm i -g openclaw"

# ---------- 1. build ----------
if [[ "$DO_BUILD" -eq 1 ]]; then
  say "Building plugin (pnpm build)…"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm build
  else
    warn "pnpm not found, falling back to npx tsc"
    npx --yes tsc
  fi
  ok "Build completed."
else
  warn "Skipping build (--no-build)."
fi

# ---------- 2. sanity check dist ----------
say "Checking dist/ artifacts…"
for f in dist/index.js dist/setup-entry.js; do
  [[ -f "$f" ]] || die "$f missing. Run without --no-build."
done
ok "dist/index.js & dist/setup-entry.js present."

# ---------- 3. restart gateway ----------
say "Restarting OpenClaw gateway…"
openclaw gateway restart
# Gateway needs a moment to re-scan the plugin registry.
sleep 2
ok "Gateway restarted."

# ---------- 4. verify ----------
if [[ "$DO_VERIFY" -eq 1 ]]; then
  say "Inspecting plugin: $PLUGIN_ID"
  # Show the useful lines; but also grep to determine "loaded" status robustly.
  INSPECT_OUT="$(openclaw plugins inspect "$PLUGIN_ID" 2>&1 || true)"
  echo "$INSPECT_OUT" | sed -n '1,20p'

  if echo "$INSPECT_OUT" | grep -qE '^Status:[[:space:]]+loaded'; then
    ok "Plugin status: loaded."
  else
    warn "Plugin does not appear to be in 'loaded' status. Full output above."
    warn "Try: openclaw plugins doctor  |  openclaw logs --limit 60 --plain"
    exit 1
  fi

  say "Running plugins doctor…"
  openclaw plugins doctor || warn "plugins doctor reported issues (see above)."
else
  warn "Skipping verification (--skip-verify)."
fi

ok "Done. Plugin is up-to-date in OpenClaw."
