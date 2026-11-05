package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"gotest.tools/v3/assert"
)

// impd's tests read testdata/stats.golden too
// (packages/daemon/src/vm/vmm/uffd-handler.test.ts), so a change to the
// layout on either side fails a test.
func TestHandlerStatsWriteTheLayoutImpdReads(t *testing.T) {
	dir := t.TempDir()
	stats, err := openHandlerStats(writeStatsFile(t, dir))
	assert.NilError(t, err)
	t.Cleanup(stats.close)
	for range 151 {
		stats.record(copiedData, time.Millisecond)
	}
	for range 63 {
		stats.record(copiedHole, time.Millisecond)
	}

	stats.record(copyRetry, 174_400*time.Microsecond)

	written, err := os.ReadFile(filepath.Join(dir, "uffd.stats"))
	assert.NilError(t, err)
	golden, err := os.ReadFile(filepath.Join("testdata", "stats.golden"))
	assert.NilError(t, err)
	assert.DeepEqual(t, written, golden)
}
