#!/usr/bin/env bash
# Serve this folder so index.html runs. http:// is required — ES modules and
# the <video> texture upload both refuse file://. Usage: ./serve.sh [port] (8000).
set -euo pipefail
cd "$(dirname "$0")"
port="${1:-8000}"
echo "serving on http://localhost:$port"
exec uv run python -m http.server "$port"
