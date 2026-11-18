#!/bin/bash
exec bun "$(dirname "$0")/run-test-zfs.ts" "$@"
