#!/bin/bash
exec bun "$(dirname "$0")/../packages/e2e-harness/src/zfs-host-test.ts" "$@"
