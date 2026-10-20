#!/bin/sh
set -eu
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
hooks="$(git rev-parse --absolute-git-dir)/worktree-hooks"
git config extensions.worktreeConfig true
git config --worktree core.hooksPath "$hooks"
exec lefthook install "$@"
