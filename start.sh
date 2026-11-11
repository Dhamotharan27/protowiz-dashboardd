#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Install Node.js first: https://nodejs.org"; exit 1; fi
OPEN_BROWSER=1 node server.js
