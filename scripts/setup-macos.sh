#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22 or newer is required. Install the current LTS from https://nodejs.org/en/download and reopen Terminal." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Reinstall Node.js from https://nodejs.org/en/download." >&2
  exit 1
fi
major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [ "$major" -lt 22 ]; then
  echo "Node.js 22 or newer is required." >&2
  exit 1
fi

npm install
npm run setup:chromium
npm run setup
echo "Platform setup complete. Run: npm run init"
