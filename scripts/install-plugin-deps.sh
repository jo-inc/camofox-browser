#!/bin/sh
# Install system packages declared by plugins in plugins/*/apt.txt
# Each apt.txt has one package per line. Lines starting with # are comments.

set -e

PKGS=""
for f in /app/plugins/*/apt.txt; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    # Skip comments and blank lines
    case "$line" in
      \#*|"") continue ;;
    esac
    PKGS="$PKGS $line"
  done < "$f"
done

if [ -z "$PKGS" ]; then
  echo "[install-plugin-deps] No plugin apt dependencies found"
  exit 0
fi

echo "[install-plugin-deps] Installing:$PKGS"
apt-get update && apt-get install -y $PKGS && rm -rf /var/lib/apt/lists/*
