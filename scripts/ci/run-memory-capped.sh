#!/bin/bash
# Run a command as this user inside a cgroup capped at <MiB> of memory with no
# swap, then print the cgroup's memory.peak and memory.events. Fail when the
# command fails or the kernel OOM-killed anything in the cgroup.
#   scripts/ci/run-memory-capped.sh 1536 bun test
# The scope comes from systemd-run through sudo, so it needs systemd and a
# passwordless sudo, as a GitHub runner has.
set -euo pipefail

if [ "$#" -lt 2 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: run-memory-capped.sh <MiB> <command> [args...]" >&2
  exit 2
fi

mib=$1
shift

# runs inside the scope: the command, then the scope's own counters, read
# while this shell still holds the scope open
report='
cgroup="/sys/fs/cgroup$(sed -n "s/^0:://p" /proc/self/cgroup)"
status=0
"$@" || status=$?
peak=$(cat "$cgroup/memory.peak")
echo "run-memory-capped: memory.max $(cat "$cgroup/memory.max"), memory.swap.max $(cat "$cgroup/memory.swap.max")"
echo "run-memory-capped: memory.peak $peak ($((peak / 1024 / 1024)) MiB)"
echo "run-memory-capped: memory.events"
sed "s/^/  /" "$cgroup/memory.events"
if [ "$(sed -n "s/^oom_kill //p" "$cgroup/memory.events")" != 0 ]; then
  echo "::error::the command went over its memory cap: the kernel OOM-killed a process (memory.events oom_kill)"
  exit 1
fi
exit "$status"
'

# sudo keeps the environment, and PATH, which its secure_path resets;
# OOMPolicy=continue keeps the scope, and this report, alive when the kernel
# kills the command
exec sudo --preserve-env env "PATH=$PATH" systemd-run --scope --quiet \
  --unit="run-memory-capped-$$" \
  --uid="$(id -u)" --gid="$(id -g)" \
  -p MemoryMax="${mib}M" -p MemorySwapMax=0 -p OOMPolicy=continue \
  -- bash -c "$report" run-memory-capped "$@"
