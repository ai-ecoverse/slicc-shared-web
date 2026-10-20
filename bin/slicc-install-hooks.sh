#!/bin/sh
set -eu
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
common="$(git rev-parse --path-format=absolute --git-common-dir)"
for key in core.bare core.worktree; do
  if value=$(git config --file "$common/config" --get "$key"); then
    git config --file "$common/config.worktree" --get "$key" >/dev/null || git config --file "$common/config.worktree" "$key" "$value"
    git config --file "$common/config" --unset "$key"
  fi
done
hooks="$(git rev-parse --absolute-git-dir)/worktree-hooks"
git config extensions.worktreeConfig true
git config --worktree core.hooksPath "$hooks"
exec lefthook install "$@"
