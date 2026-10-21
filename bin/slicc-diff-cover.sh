#!/bin/sh
set -eu
if ! command -v uvx > /dev/null 2>&1; then
  printf 'slicc-diff-cover runs diff-cover through uvx; install uv first: https://docs.astral.sh/uv/getting-started/installation/\n' >&2
  exit 1
fi
[ "$#" -gt 0 ] || set -- coverage/unit/lcov.info
n="${GIT_CONFIG_COUNT:-0}"
export "GIT_CONFIG_COUNT=$((n + 2))" "GIT_CONFIG_KEY_$n=core.quotePath" "GIT_CONFIG_VALUE_$n=false"
export "GIT_CONFIG_KEY_$((n + 1))=diff.renames" "GIT_CONFIG_VALUE_$((n + 1))=true"
exec uvx diff-cover@10.6.0 "$@" --compare-branch HEAD --ignore-unstaged --fail-under 100
