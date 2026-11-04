#!/bin/bash
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1
exec /bin/bash "$SCRIPT_DIR/macos.sh" --configure
