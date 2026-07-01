#!/usr/bin/env bash
# Build a Chrome Web Store upload package.
# Zips ONLY the files the extension needs at runtime — manifest at the zip root,
# plus service-worker.js, src/, options/, icons/. Excludes tests, docs, git, and
# this script. Output: dist/simple-bookmarks-backup-<version>.zip
set -euo pipefail

cd "$(dirname "$0")"

# Read the version out of manifest.json (simple grep; no jq dependency needed).
VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' manifest.json | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')

mkdir -p dist
OUT="dist/simple-bookmarks-backup-${VERSION}.zip"
rm -f "$OUT"

# Only these paths go into the store package.
zip -r -X "$OUT" \
  manifest.json \
  service-worker.js \
  src \
  options \
  icons \
  -x '*/.*' >/dev/null   # skip any dotfiles that sneak into those dirs

echo "Built $OUT"
unzip -l "$OUT"
