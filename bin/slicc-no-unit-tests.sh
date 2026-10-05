#!/bin/sh
set -u
found=$(git ls-files --cached --others --exclude-standard | grep -E '(^|/)(tests?|__tests__)/|\.(test|spec)\.' | grep -vE '^test/integration/')
if [ -n "$found" ]; then
  printf 'Unit tests stay out of git; keep them in the gitignored test/unit/:\n%s\n' "$found" >&2
  exit 1
fi
