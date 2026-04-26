#!/usr/bin/env bash
set -euo pipefail

# Release script for @askjo/camofox-browser
# Usage: ./release.sh [patch|minor|major]
# Defaults to patch if no argument given.

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: ./release.sh [patch|minor|major]"
  exit 1
fi

cd "$(dirname "$0")"

# --- Pre-flight checks ---
echo "🔍 Pre-flight checks..."

# Clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# On master
BRANCH=$(git branch --show-current)
if [[ "$BRANCH" != "master" ]]; then
  echo "❌ Not on master (on $BRANCH). Switch to master first."
  exit 1
fi

# Up to date with remote
git fetch origin master --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/master)
if [[ "$LOCAL" != "$REMOTE" ]]; then
  echo "❌ Local master ($LOCAL) differs from origin ($REMOTE). Pull/push first."
  exit 1
fi

# --- npm auth ---
echo "🔑 Checking npm auth..."
if ! npm whoami --registry=https://registry.npmjs.org/ 2>/dev/null; then
  echo ""
  echo "Not logged in to npm. Logging in..."
  echo "(Use your npmjs.com credentials or create a token at https://www.npmjs.com/settings/tokens)"
  echo ""
  npm login --registry=https://registry.npmjs.org/
  echo ""
fi
NPM_USER=$(npm whoami --registry=https://registry.npmjs.org/)
echo "✅ Logged in as: $NPM_USER"

# --- Tests ---
echo ""
echo "🧪 Running tests..."
NODE_OPTIONS='--experimental-vm-modules' npx jest --runInBand --forceExit --testPathPattern='tests/unit' 2>&1 | tail -5
echo ""
# reporter.test.js uses node:test, not Jest
node --test tests/unit/reporter.test.js 2>&1 | tail -3
echo ""

# --- Version bump ---
CURRENT=$(node -p "require('./package.json').version")
echo "📦 Current version: $CURRENT"
echo "📦 Bumping: $BUMP"
echo ""

# npm version bumps package.json, runs the "version" lifecycle script
# (which syncs openclaw.plugin.json), creates a git commit and tag
npm version "$BUMP" --message "v%s"

NEW_VERSION=$(node -p "require('./package.json').version")
echo ""
echo "📦 New version: $NEW_VERSION"

# --- Publish ---
echo ""
echo "🚀 Publishing @askjo/camofox-browser@$NEW_VERSION..."
npm publish --access public

# --- Push ---
echo ""
echo "📤 Pushing commit and tag..."
git push origin master --follow-tags

echo ""
echo "✅ Released @askjo/camofox-browser@$NEW_VERSION"
echo "   https://www.npmjs.com/package/@askjo/camofox-browser/v/$NEW_VERSION"
