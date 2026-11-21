#!/usr/bin/env bun
// ci.yml runs this path and reads this folder's go.mod and go.sum, so this file stays here and
// forwards to the runner in the daemon's test helpers.
await import('@impz/daemon/test-utils/dockerfile-difftest/run');
