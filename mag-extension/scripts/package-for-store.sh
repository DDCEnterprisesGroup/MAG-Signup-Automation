#!/bin/sh
# Build a Chrome Web Store submission ZIP for the MAG extension.
# Includes only what the store needs to review/run: manifest.json + src/.
# Excludes tests/, fixtures/, docs/, package.json, and this scripts/ dir.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(node -e "console.log(require('$ROOT/manifest.json').version)")
OUT_DIR="$ROOT/dist"
OUT_ZIP="$OUT_DIR/mag-extension-v${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_ZIP"
cd "$ROOT"
zip -r -X "$OUT_ZIP" manifest.json src >/dev/null
echo "PASS: built $OUT_ZIP"
unzip -l "$OUT_ZIP" | tail -1
