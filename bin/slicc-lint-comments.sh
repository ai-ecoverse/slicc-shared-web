#!/bin/sh
set -eu
sha=9cc7617c94c24b84c4d6fd8edf92441378257d07
dir="node_modules/.cache/slicc-no-comment-$sha"
if [ ! -f "$dir/check.mjs" ]; then
  mkdir -p "$dir"
  for file in lib comments marker check; do
    curl -fsSL -o "$dir/$file.mjs" "https://raw.githubusercontent.com/ai-ecoverse/slicc/$sha/packages/dev-tools/no-comment/$file.mjs"
  done
fi
exec node "$dir/check.mjs" --force "$@"
