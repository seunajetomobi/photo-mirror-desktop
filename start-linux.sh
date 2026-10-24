#!/bin/bash
# Photo Mirror for Linux without installing anything but Node.js.
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Photo Mirror needs Node.js 18 or newer (https://nodejs.org)."; exit 1; }
PM_OPEN=1 exec node server/server.js
