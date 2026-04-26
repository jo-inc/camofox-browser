#!/usr/bin/env bash
set -euo pipefail

# Release script for @askjo/camofox-browser
# Usage: ./release.sh [patch|minor|major]
# Defaults to patch if no argument given.
#
# This script:
#   1. Runs pre-flight checks (clean tree, on master, up to date)
#   2. Runs tests locally
#   3. Bumps version via npm version (which syncs openclaw.plugin.json)
#   4. Pushes commit + tag to origin
#   5. GitHub Actions publishes to npm with provenance
#
# The actual npm publish happens in CI (.github/workflows/publish.yml).

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

# --- Tests ---
echo ""
echo "🧪 Running tests..."
JEST_OUTPUT=$(NODE_OPTIONS='--experimental-vm-modules' npx jest --runInBand --forceExit --testPathPattern='tests/unit' --testPathIgnorePatterns='reporter\.test' 2>&1)
echo "$JEST_OUTPUT" | tail -5
if echo "$JEST_OUTPUT" | grep -q 'Tests:.*failed'; then
  echo "❌ Tests failed"
  exit 1
fi
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

# --- Push (triggers CI publish) ---
echo ""
echo "📤 Pushing commit and tag (CI will publish to npm)..."
git push origin master --follow-tags

echo ""
echo "✅ Release v${NEW_VERSION} triggered"
echo "   CI will publish @askjo/camofox-browser@${NEW_VERSION} with provenance"
echo "   Watch: https://github.com/jo-inc/camofox-browser/actions"
echo "   Package: https://www.npmjs.com/package/@askjo/camofox-browser"
