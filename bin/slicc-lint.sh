#!/bin/sh
set -eu
bin=$(dirname "$(readlink -f "$0")")
npx --no-install biome check .
if node -e "process.exit(require('./package.json').scripts?.typecheck ? 0 : 1)"; then
  npm run --silent typecheck
fi
"$bin/slicc-lint-comments.sh"
"$bin/slicc-no-unit-tests.sh"
"$bin/slicc-agents-md.sh"
