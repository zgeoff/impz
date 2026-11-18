#!/bin/bash
exec bun "$(dirname "$0")/run-dev.ts" "$@"
