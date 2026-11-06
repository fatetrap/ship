#!/usr/bin/env bash
# Mac/Linux: ./ship.sh opens the Ship board. ./ship.sh done <slug>, ./ship.sh pdf <file>, ./ship.sh triage, ...
cd "$(dirname "$0")"
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"
exec "$PY" .agent/ship.py "$@"
