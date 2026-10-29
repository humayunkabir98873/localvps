#!/bin/sh
# LocalVPS launcher (macOS/Linux): starts the control panel and opens it in the browser.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js 22+ is required: https://nodejs.org/"; exit 1; }
if [ ! -d node_modules/mysql2 ]; then
  echo "Installing panel dependencies..."
  npm install --omit=dev || exit 1
fi
exec node panel/server.js --open
