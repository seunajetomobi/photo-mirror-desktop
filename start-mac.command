#!/bin/bash
# Photo Mirror for macOS without installing anything but Node.js. Double-click this file.
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Photo Mirror needs Node.js 18 or newer. Install it from https://nodejs.org and open this file again."
  read -n 1 -s -r -p "Press any key to close"; exit 1
fi
PM_OPEN=1 node server/server.js
