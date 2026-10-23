#!/bin/bash
exec bun "$(dirname "$0")/dev.ts" "$@"
