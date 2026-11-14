#!/bin/sh
set -eu
case $0 in
  */*) PACKAGE_DIR=${0%/*} ;;
  *) PACKAGE_DIR=. ;;
esac
PACKAGE_DIR=$(CDPATH= cd "$PACKAGE_DIR" && pwd)
exec "$PACKAGE_DIR/runtime/node" "$PACKAGE_DIR/src/cli.mjs" "$@"
