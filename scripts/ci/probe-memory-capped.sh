#!/bin/bash
# Run a command as this user inside a cgroup capped at <MiB> of memory with no
# swap, then print the cgroup's memory.peak and memory.events. Fail when the
# command fails or the kernel OOM-killed anything in the cgroup.
#   scripts/ci/run-memory-capped.sh 1536 bun test
# The scope comes from systemd-run through sudo, so it needs systemd and a
# passwordless sudo, as a GitHub runner has.
set -euo pipefail

# inside the scope, as root: the command as the caller, with the caller's
# groups such as docker, then the scope's counters while this shell holds it
if [ "${1:-}" = --inside ]; then
  user=$2
  shift 2
  cgroup="/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/self/cgroup)"

  # memory.peak counts the page cache, which the kernel takes back under the
  # cap; the anonymous memory, sampled each second, is what it cannot
  anon_file=$(mktemp)
  echo 0 >"$anon_file"
  (
    peak=0; anon_max=0; shmem_max=0
    while sleep 0.5; do
      anon=$(sed -n 's/^anon //p' "$cgroup/memory.stat")
      shmem=$(sed -n 's/^shmem //p' "$cgroup/memory.stat")
      file=$(sed -n 's/^file //p' "$cgroup/memory.stat")
      current=$(cat "$cgroup/memory.current")
      [ "$anon" -gt "$anon_max" ] && anon_max=$anon
      [ "$shmem" -gt "$shmem_max" ] && shmem_max=$shmem
      sum=$((anon + shmem))
      if [ "$sum" -gt "$peak" ]; then
        peak=$sum
        echo "$anon" >"$anon_file"
        echo "PROBEMEM at anon+shmem peak: anon=$((anon/1048576)) shmem=$((shmem/1048576)) file=$((file/1048576)) current=$((current/1048576)) MiB" >"$anon_file.atpeak"
      fi
      echo "PROBEMEM max: anon=$((anon_max/1048576)) shmem=$((shmem_max/1048576)) MiB" >"$anon_file.max"
    done
  ) &
  sampler=$!

  status=0
  setpriv --reuid="$user" --regid="$(id -g "$user")" --init-groups -- "$@" || status=$?

  kill "$sampler"
  peak=$(cat "$cgroup/memory.peak")
  anon=$(cat "$anon_file")
  cat "$anon_file.atpeak" "$anon_file.max" 2>/dev/null || true
  rm -f "$anon_file" "$anon_file.atpeak" "$anon_file.max"
  echo "run-memory-capped: memory.max $(cat "$cgroup/memory.max"), memory.swap.max $(cat "$cgroup/memory.swap.max")"
  echo "run-memory-capped: memory.peak $peak ($((peak / 1024 / 1024)) MiB)"
  echo "run-memory-capped: anon peak, sampled each second, $anon ($((anon / 1024 / 1024)) MiB)"
  echo "run-memory-capped: memory.events"
  sed 's/^/  /' "$cgroup/memory.events"
  if [ "$(sed -n 's/^oom_kill //p' "$cgroup/memory.events")" != 0 ]; then
    echo "::error::the command went over its memory cap: the kernel OOM-killed a process (memory.events oom_kill)"
    exit 1
  fi
  exit "$status"
fi

if [ "$#" -lt 2 ] || ! [[ "$1" =~ ^[0-9]+$ ]]; then
  echo "usage: run-memory-capped.sh <MiB> <command> [args...]" >&2
  exit 2
fi

mib=$1
shift

# sudo keeps the environment, and PATH, which its secure_path resets;
# OOMPolicy=continue keeps the scope, and its report, alive when the kernel
# kills the command
exec sudo --preserve-env env "PATH=$PATH" systemd-run --scope --quiet \
  --unit="run-memory-capped-$$" \
  -p MemoryMax="${mib}M" -p MemorySwapMax=0 -p OOMPolicy=continue \
  -- "$0" --inside "$(id -un)" "$@"
