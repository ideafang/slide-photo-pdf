#!/bin/sh
cd "$(dirname "$0")"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8766}"
echo "Open http://${HOST}:${PORT}/"
echo "Processing runs in the browser. Do not open index.html as a file."
exec python3 -m http.server "$PORT" --bind "$HOST"
