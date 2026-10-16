#!/bin/sh
set +e
own=$(sed -n 's/^0:://p' /proc/self/cgroup 2>/dev/null)
first() {
  found=n/a
  from=-
  for file in "$@"; do
    if [ -r "$file" ]; then
      value=$(cat "$file" 2>/dev/null)
      if [ -n "$value" ]; then
        found=$value
        from=$file
        return
      fi
    fi
  done
}
mib() {
  case "$1" in
    max) printf 'unlimited' ;;
    '' | *[!0-9]*) printf 'n/a' ;;
    *)
      if [ "${#1}" -gt 15 ]; then
        printf 'unlimited'
      else
        printf '%s MiB' $(($1 / 1048576))
      fi
      ;;
  esac
}
first "/sys/fs/cgroup$own/memory.peak" /sys/fs/cgroup/memory.peak /sys/fs/cgroup/memory/memory.max_usage_in_bytes
peak=$found
peak_file=$from
first "/sys/fs/cgroup$own/memory.max" /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes
limit=$found
limit_file=$from
cpus=$(nproc 2>/dev/null || echo n/a)
line="memory peak $(mib "$peak") ($peak_file), limit $(mib "$limit") ($limit_file), nproc $cpus, runner ${SLICC_RUNNER_NAME:-${RUNNER_NAME:-n/a}}"
echo "$line"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  printf '### Memory\n\n%s\n' "$line" >> "$GITHUB_STEP_SUMMARY" 2>/dev/null
fi
exit 0
