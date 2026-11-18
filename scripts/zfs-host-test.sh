#!/bin/bash
exec bun "$(dirname "$0")/run-zfs-host-test.ts" "$@"
