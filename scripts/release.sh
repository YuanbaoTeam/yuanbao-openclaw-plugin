#!/bin/bash

# Release automation script
# Usage: pnpm release [patch|minor|major|beta] "commit message"
#
# Examples:
#   pnpm release patch "fix message parsing"
#   pnpm release minor "add new feature"
#   pnpm release major "breaking change"
#   pnpm release beta "test new feature"

set -e

BUMP_TYPE=${1:-patch}
MESSAGE=${2:-"release"}

# Validate bump type
if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major|beta)$ ]]; then
  echo "Error: Invalid bump type '$BUMP_TYPE'"
  echo "Usage: pnpm release [patch|minor|major|beta] \"commit message\""
  exit 1
fi

# Bump version
if [ "$BUMP_TYPE" = "beta" ]; then
  # Check if current version already contains beta prerelease tag
  CURRENT_VERSION=$(node -p "require('./package.json').version")
  if [[ "$CURRENT_VERSION" == *"beta"* ]]; then
    npm version prerelease --preid beta --no-git-tag-version > /dev/null
  else
    npm version prepatch --preid beta --no-git-tag-version > /dev/null
  fi
else
  npm version "$BUMP_TYPE" --no-git-tag-version > /dev/null
fi

VERSION=$(node -p "require('./package.json').version")

# Commit, tag, and push
git add .
git commit -m "$MESSAGE (v$VERSION)"
git tag "v$VERSION"
git push origin main --follow-tags

echo ""
echo "✅ Released v$VERSION successfully!"
echo "   Commit: $MESSAGE (v$VERSION)"
echo "   Tag: v$VERSION"
echo "   CI publish will be triggered automatically."
