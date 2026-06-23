#!/usr/bin/env bash
# Publish the staged Quasar CLI release to npm (platform packages first, then the
# main package), then verify. Prerequisite: `npm login` — the npm auth token must
# be valid (publishing PUTs return E404/E401 when it is not). Idempotent per
# version: npm rejects re-publishing a version that already exists.
#
#   npm login
#   bash scripts/publish-release.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
REL="$REPO/.release/npm"
PKG_DIR="$REPO/packages/cli"
VERSION="$(node -p "require('$PKG_DIR/package.json').version")"

echo "==> publishing @skastr0/quasar-cli@$VERSION"

if [ ! -d "$REL" ] || [ -z "$(ls -A "$REL" 2>/dev/null)" ]; then
  echo "ERROR: no staged platform packages in $REL — run 'bun run --cwd packages/cli build:npm-packages' first." >&2
  exit 1
fi

echo "==> verifying npm auth"
if ! WHO="$(npm whoami --registry https://registry.npmjs.org 2>/dev/null)"; then
  echo "ERROR: not authenticated to npm. Run 'npm login' first." >&2
  exit 1
fi
echo "    authed as $WHO"

echo "==> publishing platform packages"
for d in "$REL"/*/; do
  echo "    $(basename "$d")"
  (cd "$d" && npm publish --access public)
done

echo "==> publishing main package"
(cd "$PKG_DIR" && npm publish --access public)

echo "==> verify"
npm view "@skastr0/quasar-cli@$VERSION" version
echo "DONE: @skastr0/quasar-cli@$VERSION published."
