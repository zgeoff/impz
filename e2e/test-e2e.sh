#!/bin/bash
# The imp end-to-end harness: every suite drives impd in the dev container
# through the CLI, the way a user would. The suites live in e2e/.
#
#   e2e/test-e2e.sh [--only SUITES | --group N] [--clean | --reuse] [--keep]
#
# --group N runs one of the fast set's CI groups
# (packages/e2e-harness/src/suites.ts FAST_GROUPS), as each of CI's e2e runners does.
#
# e2e/test-e2e.sh --help lists the suites, sets and tuning env.
set -euo pipefail
exec bun "$(dirname "$0")/../packages/e2e-harness/src/main.ts" "$@"
