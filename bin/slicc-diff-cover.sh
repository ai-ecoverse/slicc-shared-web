#!/bin/sh
set -eu
exec uvx diff-cover@10.6.0 "${1:-coverage/unit/lcov.info}" --compare-branch HEAD --ignore-unstaged --fail-under 100
