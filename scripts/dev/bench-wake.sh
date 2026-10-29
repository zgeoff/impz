#!/bin/bash
# Measure wakes of an imp put to sleep right after a cold boot: the case a
# host kernel before Linux 6.7 makes slow (docs/architecture/lifecycle/sleep-and-wake.md#young-guests).
#
#   scripts/dev/bench-wake.sh [--cycles N] [--awake S] [--limit-ms MS] [--memory M]
#
# It runs `impz bench wake-young` at concurrency 1: each cycle stops and
# starts the imp, waits --awake seconds (default 0), sleeps it and times the
# wake. It fails when the median wake passes --limit-ms (default 500). A slow
# wake takes 700-1100 ms on an affected host; a normal one 100-200 ms.
#
# It drives impd through the impz CLI, so it runs against any host: set
# IMP_URL and IMP_TOKEN, or use the saved login. IMP_BIN picks the CLI
# (default: scripts/impz from this checkout). To see the effect itself, run
# impd with IMP_SLEEP_MIN_GUEST_UPTIME_MS=0; with the default, impd waits
# out the young guest and the wakes stay fast.
set -euo pipefail

cycles=3
awake=0
limit_ms=500
memory=1g

while [ $# -gt 0 ]; do
  case $1 in
    --cycles) cycles=$2 ;;
    --awake) awake=$2 ;;
    --limit-ms) limit_ms=$2 ;;
    --memory) memory=$2 ;;
    *)
      echo "bench-wake: unknown option $1" >&2
      exit 2
      ;;
  esac
  shift 2
done

exec "${IMP_BIN:-$(dirname "$0")/../impz}" bench wake-young --concurrency 1 --samples "$cycles" \
  --awake "$awake" --memory "$memory" --limit-p50-ms "$limit_ms"
