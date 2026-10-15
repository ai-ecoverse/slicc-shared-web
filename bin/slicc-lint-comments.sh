#!/bin/sh
set -eu
sha=e2babd275809ef7afbd3588f4d2d260bd278f8ee
dir="node_modules/.cache/slicc-no-comment-$sha"
if [ ! -f "$dir/check.mjs" ]; then
  mkdir -p "$dir"
  for file in lib comments marker check; do
    curl -fsSL -o "$dir/$file.mjs" "https://raw.githubusercontent.com/ai-ecoverse/slicc/$sha/packages/dev-tools/no-comment/$file.mjs"
  done
fi
report=$(node "$dir/check.mjs" --force "$@" 2>&1) || true
if [ -z "$report" ]; then
  printf 'slicc-lint-comments: the no-comment checker produced no report\n' >&2
  exit 1
fi
renovate='^(\.github/workflows/[^/:]+|(.+/)?action)\.ya?ml:[0-9]+: comment not allowed: # renovate: datasource=[a-z.-]+ depName=[^ ]+( packageName=[^ ]+)?( versioning=[^ ]+)?( extractVersion=[^ ]+)?( registryUrl=[^ ]+)?$'
rest=$(printf '%s\n' "$report" | grep -vE '^ok: |^(.+/)?AGENTS\.md: documentation file is not allowed' | grep -vE "$renovate" || true)
if [ -n "$rest" ]; then
  printf '%s\n' "$rest" >&2
  exit 1
fi
printf 'ok: no comments besides # renovate: annotations, and no documentation besides README.md and AGENTS.md\n'
