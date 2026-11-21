// ci.yml calls this path and reads this folder's go.mod and go.sum, so the runner itself lives in
// the daemon's test helpers.
await import('@impz/daemon/test-utils/dockerfile-difftest/run');
