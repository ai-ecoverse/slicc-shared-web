#!/bin/sh
set -eu
[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" = true ] || exit 0
own="$(git rev-parse --path-format=absolute --git-dir)/config.worktree"
if [ -f "$own" ]; then
  case "$(git config --file "$own" --get-all core.hooksPath || true)" in
    *worktree-hooks*) git config --file "$own" --unset-all core.hooksPath ;;
  esac
fi
git config core.hooksPath "$(git rev-parse --show-prefix).githooks"
n="${GIT_CONFIG_COUNT:-0}"
(
  export "GIT_CONFIG_COUNT=$((n + 1))" "GIT_CONFIG_KEY_$n=core.hooksPath" "GIT_CONFIG_VALUE_$n=$(pwd -P)/node_modules/.git-hooks"
  lefthook install --force "$@"
)
mkdir -p .githooks
for hook in node_modules/.git-hooks/*; do
  name="${hook##*/}"
  case "$name" in *.*) continue ;; esac
  if [ ! -f "$hook" ] || [ -e ".githooks/$name" ]; then continue; fi
  cat >".githooks/$name" <<'SHIM'
#!/bin/sh
hook="${0%/*}/../node_modules/.git-hooks/${0##*/}"
[ -x "$hook" ] || { echo "${0##*/}: run npm install" >&2; exit 1; }
exec "$hook" "$@"
SHIM
  chmod +x ".githooks/$name"
done
