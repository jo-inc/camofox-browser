#!/bin/bash
# Patch playwright-core's Firefox CDP viewport call to strip isMobile
# Firefox CDP rejects isMobile in Browser.setDefaultViewport, causing tab creation to fail.
PBUNDLE="node_modules/playwright-core/lib/coreBundle.js"
if [ -f "$PBUNDLE" ]; then
  # Remove the "isMobile: !!this._options.isMobile" line from the viewport object
  sed -i '/isMobile: !!this._options.isMobile/d' "$PBUNDLE"
fi
exec "$@"
