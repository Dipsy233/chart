#!/usr/bin/env bash
# ===========================================================================
#  CHART / Regimen — start the rule editor
#
#  One command that gets this checkout running:
#
#    1. installs dependencies when node_modules is missing (root + web/)
#    2. starts the Vite dev server for the editor in web/
#    3. prints the URL
#
#  The editor imports ../src directly, so there is no build step between the
#  engine and the UI — edit a rule engine file and the page reloads.
#
#  Usage:
#    ./start-chart.sh              start the editor (http://localhost:5174)
#    ./start-chart.sh open         start it and open a browser
#    ./start-chart.sh check        run the 588 checks, then exit
#    ./start-chart.sh demo         print the demo report, then exit
#    ./start-chart.sh rules        the rule-pack CLI (passes the rest through)
#    ./start-chart.sh api          the rules API for agents (http://127.0.0.1:5175)
#    ./start-chart.sh serve        build the editor, serve it + the API on one port
#    ./start-chart.sh build        production build of the editor
#
#  Env:
#    CHART_PORT=5174     port for the dev server
#    CHART_API_PORT=5175 port for the rules API
#    CHART_RULES_DIR     where the CLI's packs live (default .chart/rules)
# ===========================================================================
set -euo pipefail

# The script is at the repo root; resolve the absolute path so it works from
# anywhere (and through a symlink).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO"

PORT="${CHART_PORT:-5174}"
API_PORT="${CHART_API_PORT:-5175}"

echo "============================================================"
echo "  CHART / Regimen — observation engine + rule editor"
echo "------------------------------------------------------------"
echo "  repo  : $REPO"
echo "  node  : $(node --version 2>/dev/null || echo 'MISSING')"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
	echo "node is not on PATH — install Node 20 or newer." >&2
	exit 1
fi

# ── dependencies ─────────────────────────────────────────────────────────
# Only install when something is missing: a fresh install is 20s, and the
# editor is usually opened many times in a row.
if [ ! -d node_modules ]; then
	echo "→ installing library dev dependencies…"
	npm install --no-audit --no-fund
fi
if [ ! -d web/node_modules ]; then
	echo "→ installing editor dependencies…"
	(cd web && npm install --no-audit --no-fund)
fi

case "${1:-start}" in
check)
	echo "→ running the checks"
	npm run --silent check
	;;
demo)
	echo "→ the demo run"
	npm run --silent demo
	;;
rules)
	shift
	exec npm run --silent rules -- "$@"
	;;
api)
	shift
	exec npm run --silent api -- --port "$API_PORT" "$@"
	;;
serve)
	echo "→ building the editor, then serving it with the API on http://localhost:$API_PORT"
	npm run --silent web:build
	exec npm run --silent api -- --port "$API_PORT" --static web/dist
	;;
build)
	echo "→ production build of the editor"
	(cd web && npx tsc --noEmit && npx vite build)
	echo "  output: web/dist"
	;;
open)
	echo "→ starting the editor on http://localhost:$PORT (opening a browser)"
	echo "  ctrl-c to stop"
	(cd web && npx vite --port "$PORT" --open)
	;;
start | "")
	echo "→ starting the editor on http://localhost:$PORT"
	echo "  ctrl-c to stop"
	(cd web && npx vite --port "$PORT")
	;;
*)
	echo "usage: $0 [start|open|check|demo|rules|api|serve|build]" >&2
	exit 2
	;;
esac
