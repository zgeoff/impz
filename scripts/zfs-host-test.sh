#!/bin/bash
exec bun "$(dirname "$0")/zfs-host-test.ts" "$@"
