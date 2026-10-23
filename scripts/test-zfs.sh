#!/bin/bash
exec bun "$(dirname "$0")/test-zfs.ts" "$@"
