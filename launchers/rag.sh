#!/bin/sh
set -eu
PACKAGE_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)
exec "$PACKAGE_DIR/runtime/node" "$PACKAGE_DIR/src/cli.mjs" "$@"
