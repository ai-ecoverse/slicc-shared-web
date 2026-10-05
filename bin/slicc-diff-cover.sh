#!/bin/sh
set -eu
if ! command -v uvx > /dev/null 2>&1; then
  printf 'slicc-diff-cover runs diff-cover through uvx; install uv first: https://docs.astral.sh/uv/getting-started/installation/\n' >&2
  exit 1
fi
exec uvx diff-cover@10.6.0 "${1:-coverage/unit/lcov.info}" --compare-branch HEAD --ignore-unstaged --fail-under 100
