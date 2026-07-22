#!/usr/bin/env bash
# mp4 -> colored-ASCII sequence. Thin wrapper over convert.py, run via uv
# (numpy is declared inline in the script, so no venv). Args pass straight
# through: ./convert.sh in.mp4 seq.json.gz [--cols 120] [--fps 24] [--ramp "..."]
set -euo pipefail
cd "$(dirname "$0")"
exec uv run convert.py "$@"
