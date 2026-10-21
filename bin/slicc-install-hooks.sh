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
config="$(lefthook dump)"
githooks=" applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge pre-push pre-receive update proc-receive post-receive post-update reference-transaction push-to-checkout pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman p4-changelist p4-prepare-changelist p4-post-changelist p4-pre-submit post-index-change "
mkdir -p node_modules/.git-hooks .githooks
for name in $(printf '%s\n' "$config" | sed -n 's/^\([a-z][a-z0-9-]*\):.*/\1/p'); do
  case "$githooks" in *" $name "*) ;; *) continue ;; esac
  hook="node_modules/.git-hooks/$name"
  sed "s/@HOOK@/$name/g" >"$hook" <<'HOOK'
#!/bin/sh
if [ "${LEFTHOOK_VERBOSE:-}" = 1 ] || [ "${LEFTHOOK_VERBOSE:-}" = true ]; then set -x; fi
modules="$(cd "${0%/*}/.." && pwd -P)"
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
cpu="$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x64/')"
lefthook="$modules/lefthook-$os-$cpu/bin/lefthook"
[ -x "$lefthook" ] || lefthook="$modules/.bin/lefthook"
[ -x "$lefthook" ] || { echo "@HOOK@: run npm install" >&2; exit 1; }
exec "$lefthook" run --no-auto-install "@HOOK@" "$@"
HOOK
  chmod +x "$hook"
  [ ! -e ".githooks/$name" ] || continue
  cat >".githooks/$name" <<'SHIM'
#!/bin/sh
hook="${0%/*}/../node_modules/.git-hooks/${0##*/}"
[ -x "$hook" ] || { echo "${0##*/}: run npm install" >&2; exit 1; }
exec "$hook" "$@"
SHIM
  chmod +x ".githooks/$name"
done
