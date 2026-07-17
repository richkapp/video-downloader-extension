#!/bin/bash

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

for NODE_BIN in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
  if [ -x "$NODE_BIN" ]; then
    "$NODE_BIN" "$PROJECT_DIR/native-host/install.js"
    STATUS=$?
    if [ -t 0 ]; then
      echo
      read -n 1 -s -r -p "Press any key to close..."
      echo
    fi
    exit $STATUS
  fi
done

echo "Node.js was not found. Install Node.js first."
if [ -t 0 ]; then
  read -n 1 -s -r -p "Press any key to close..."
  echo
fi
exit 1
