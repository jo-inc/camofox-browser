#!/bin/bash
# Local development script for jo-browser with Camoufox engine

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

echo "Starting jo-browser (Camoufox) on http://localhost:3000 (with auto-reload)"
echo "Logs: /tmp/jo-browser-camoufox.log"
nodemon --watch server-camoufox.js --exec "node server-camoufox.js" 2>&1 | while IFS= read -r line; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $line"
done | tee -a /tmp/jo-browser-camoufox.log
