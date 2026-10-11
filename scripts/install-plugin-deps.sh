#!/bin/sh
# Install system packages declared by plugins listed in camofox.config.json.
# Each plugin can have an apt.txt (one package per line) and a post-install.sh.
# If no config file or no plugins key, installs deps for all plugins in plugins/.

set -e

CONFIG="/app/camofox.config.json"
PLUGINS_DIR="/app/plugins"

# Read plugin list from camofox.config.json, or fall back to all plugin dirs
PLUGIN_LIST=""
USE_ALL_PLUGINS=1
if [ -f "$CONFIG" ] && command -v node >/dev/null 2>&1; then
  PLUGIN_LIST=$(node -e "
    const c = JSON.parse(require('fs').readFileSync('$CONFIG','utf-8'));
    if (Array.isArray(c.plugins)) {
      console.log('selected ' + c.plugins.join(' '));
    } else if (c.plugins && typeof c.plugins === 'object') {
      console.log('selected ' + Object.entries(c.plugins)
        .filter(([name, settings]) => {
          if (settings !== false && settings?.enabled !== false) return true;
          try {
            const metadata = JSON.parse(require('fs').readFileSync(
              require('path').join('$PLUGINS_DIR', name, 'plugin.json'), 'utf8'));
            return typeof metadata.enableEnvVar === 'string' && metadata.enableEnvVar.length > 0;
          } catch {
            return false;
          }
        })
        .map(([name]) => name).join(' '));
    }
  ")
  case "$PLUGIN_LIST" in
    selected*)
      PLUGIN_LIST=${PLUGIN_LIST#selected }
      USE_ALL_PLUGINS=0
      ;;
  esac
fi

if [ "$USE_ALL_PLUGINS" -eq 1 ]; then
  # No config or no plugins key -- use all plugin directories
  PLUGIN_LIST=""
  for d in "$PLUGINS_DIR"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    case "$name" in _*|.*) continue ;; esac
    PLUGIN_LIST="$PLUGIN_LIST $name"
  done
fi

echo "[install-plugin-deps] Plugins:$PLUGIN_LIST"

# Collect apt packages
PKGS=""
for name in $PLUGIN_LIST; do
  f="$PLUGINS_DIR/$name/apt.txt"
  [ -f "$f" ] || continue
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%"$(printf '\r')"}
    case "$line" in \#*|"") continue ;; esac
    PKGS="$PKGS $line"
  done < "$f"
done

if [ -n "$PKGS" ]; then
  echo "[install-plugin-deps] Installing:$PKGS"
  apt-get update
  printf '%s\n' "$PKGS" | xargs apt-get install -y
  rm -rf /var/lib/apt/lists/*
else
  echo "[install-plugin-deps] No apt dependencies"
fi

# Run post-install hooks
for name in $PLUGIN_LIST; do
  hook="$PLUGINS_DIR/$name/post-install.sh"
  [ -x "$hook" ] || continue
  echo "[install-plugin-deps] Running post-install for $name"
  "$hook"
done
