#!/bin/sh
set -u
limit=1000
failed=0
list="${TMPDIR:-/tmp}/slicc-agents-md.$$"
git ls-files --cached --others --exclude-standard | grep -E '(^|/)(AGENTS|CLAUDE)\.md$' > "$list" || true
while IFS= read -r file; do
  case "$file" in
    CLAUDE.md | */CLAUDE.md)
      printf '%s: agent guidance lives in AGENTS.md only, with no CLAUDE.md file or symlink\n' "$file" >&2
      failed=1
      ;;
    *)
      chars=$(node -e "process.stdout.write(String([...require('node:fs').readFileSync(process.argv[1], 'utf8')].length))" "$file")
      if [ "$chars" -gt "$limit" ]; then
        printf '%s: %s characters, the limit is %s\n' "$file" "$chars" "$limit" >&2
        failed=1
      fi
      ;;
  esac
done < "$list"
count=$(wc -l < "$list" | tr -d ' ')
rm -f "$list"
if [ "$failed" -ne 0 ]; then
  printf 'slicc-agents-md: FAIL\n' >&2
  exit 1
fi
printf 'slicc-agents-md: PASS %s AGENTS.md files within %s characters, no CLAUDE.md\n' "$count" "$limit"
