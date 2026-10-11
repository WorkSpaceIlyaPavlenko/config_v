#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ ! -f "$project_dir/node_modules/yaml/package.json" ]; then
  npm --prefix "$project_dir" ci --ignore-scripts --no-audit --no-fund
fi
exec node "$project_dir/tools/lifecycle.mjs" init "$@"
