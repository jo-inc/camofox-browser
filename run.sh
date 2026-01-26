#!/bin/bash
# Local development script for jo-browser with auto-reload

# Use Playwright's bundled Chromium (has full accessibility API support)
# Only set CHROMIUM_PATH for Docker/production where we install Chromium separately
unset CHROMIUM_PATH

# Install deps if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Install nodemon globally if not available
if ! command -v nodemon &> /dev/null; then
    echo "Installing nodemon..."
    npm install -g nodemon
fi

echo "Starting jo-browser on http://localhost:3000 (with auto-reload)"
echo "Logs: /tmp/jo-browser.log"
nodemon --watch server.js --exec "node server.js" 2>&1 | while IFS= read -r line; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $line"
done | tee -a /tmp/jo-browser.log
