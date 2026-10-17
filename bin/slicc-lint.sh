#!/bin/sh
set -u
bin=$(dirname "$(readlink -f "$0")")
failed() {
  printf 'slicc-lint: FAIL %s\n' "$1" >&2
  exit "$2"
}
run() {
  name=$1
  shift
  out=$("$@" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  [ "$rc" -eq 0 ] || failed "$name" "$rc"
}
checked() {
  name=$1
  shift
  run "$name" "$@"
  printf '%s\n' "$out" | grep -q "^$name: PASS" || failed "$name (no PASS line from it)" 70
}
run biome npx --no-install biome check .
printf 'biome: PASS\n'
if node -e "process.exit(require('./package.json').scripts?.typecheck ? 0 : 1)"; then
  run typecheck npm run --silent typecheck
  printf 'typecheck: PASS\n'
fi
checked slicc-lint-comments "$bin/slicc-lint-comments.sh"
checked slicc-no-unit-tests "$bin/slicc-no-unit-tests.sh"
checked slicc-agents-md "$bin/slicc-agents-md.sh"
printf 'slicc-lint: PASS\n'
