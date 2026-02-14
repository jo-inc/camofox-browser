#!/bin/bash
# Local development script for camofox-browser
# Usage: ./run.sh [-p port]
# Example: ./run.sh -p 3001

CAMOFOX_PORT=3000
while getopts "p:" opt; do
  case $opt in
    p) CAMOFOX_PORT="$OPTARG" ;;
    *) echo "Usage: $0 [-p port]"; exit 1 ;;
  esac
done
export CAMOFOX_PORT

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Check if camoufox browser is installed
if ! npx camoufox-js --version &> /dev/null 2>&1; then
    echo "Fetching Camoufox browser..."
    npx camoufox-js fetch
fi

# Install nodemon globally if not available
if ! command -v nodemon &> /dev/null; then
    echo "Installing nodemon..."
    npm install -g nodemon
fi

echo "Starting camofox-browser on http://localhost:$CAMOFOX_PORT (with auto-reload)"
echo "Logs: /tmp/camofox-browser.log"
nodemon --watch server.js --exec "node --max-old-space-size=128 server.js" 2>&1 | while IFS= read -r line; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $line"
done | tee -a /tmp/camofox-browser.log
