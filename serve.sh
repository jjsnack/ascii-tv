#!/usr/bin/env bash
# Serve this folder so index.html can play the sequence. http:// is required —
# DecompressionStream('gzip') refuses file://. Usage: ./serve.sh [port] (8000).
set -euo pipefail
cd "$(dirname "$0")"
port="${1:-8000}"
echo "serving on http://localhost:$port"
exec uv run python -m http.server "$port"
