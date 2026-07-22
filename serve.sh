#!/usr/bin/env bash
# Serve this folder so index.html runs. http:// is required — ES modules and
# the <video> texture upload both refuse file://.
# Usage: ./serve.sh [video] [port]   (defaults: sample.mp4, 8000)
# The video must live in this folder (http.server only serves the cwd).
set -euo pipefail
cd "$(dirname "$0")"
video="${1:-sample.mp4}"
port="${2:-8000}"
url="http://localhost:$port/?v=$video"
echo "serving $video on $url"
command -v open >/dev/null && open "$url" &   # macOS: pop the browser at the right clip
exec uv run python -m http.server "$port"
