#!/bin/bash
# Run deploy/bootstrap.sh for real inside throwaway systemd containers, and
# check that a second run changes nothing. The harness lives in
# packages/e2e-harness/src/bootstrap/.
#
# e2e/test-bootstrap.sh --help lists the flags.
exec bun "$(dirname "$0")/../packages/e2e-harness/src/bootstrap/main.ts" "$@"
