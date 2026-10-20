#!/bin/sh
set -eu
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 0
own="$(git rev-parse --path-format=absolute --git-dir)/config.worktree"
if [ -f "$own" ]; then
  case "$(git config --file "$own" --get-all core.hooksPath || true)" in
    *worktree-hooks*) git config --file "$own" --unset-all core.hooksPath ;;
  esac
fi
git config core.hooksPath node_modules/.git-hooks
exec lefthook install --force "$@"
