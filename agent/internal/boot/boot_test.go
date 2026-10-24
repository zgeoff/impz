package boot

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/proto"
)

// tmpfs keeps every page resident, so the file lives in /var/tmp.
func uncachedFile(t *testing.T, pages int) string {
	t.Helper()
	dir, err := os.MkdirTemp("/var/tmp", "imp-cache-")
	assert.NilError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "imp-agent")
	assert.NilError(t, os.WriteFile(path, make([]byte, pages*os.Getpagesize()), 0o644))
	f, err := os.Open(path)
	assert.NilError(t, err)
	defer f.Close()
	assert.NilError(t, f.Sync())
	assert.NilError(t, unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED))
	return path
}

func uncachedPages(t *testing.T, path string, pages int) int {
	t.Helper()
	f, err := os.Open(path)
	assert.NilError(t, err)
	defer f.Close()
	mapped, err := unix.Mmap(int(f.Fd()), 0, pages*os.Getpagesize(), unix.PROT_READ, unix.MAP_SHARED)
	assert.NilError(t, err)
	defer unix.Munmap(mapped)
	resident := make([]byte, pages)
	_, _, errno := unix.Syscall(unix.SYS_MINCORE, uintptr(unsafe.Pointer(&mapped[0])), uintptr(len(mapped)), uintptr(unsafe.Pointer(&resident[0])))
	assert.Assert(t, errno == 0, "mincore: %v", errno)
	missing := 0
	for _, page := range resident {
		if page&1 == 0 {
			missing++
		}
	}
	return missing
}

func TestParkTemplateCachesTheAgentBinaryBeforeItParks(t *testing.T) {
	agentBinary := uncachedFile(t, 64)
	before := uncachedPages(t, agentBinary, 64)
	atPark := -1
	want := &proto.Claim{UnixMs: 1_700_000_000_000}

	got, err := parkTemplate(agentBinary, func() (*proto.Claim, error) {
		atPark = uncachedPages(t, agentBinary, 64)
		return want, nil
	})

	assert.NilError(t, err)
	assert.Check(t, got == want)
	assert.Check(t, cmp.Equal(before, 64), "the file was cached before the park")
	assert.Check(t, cmp.Equal(atPark, 0))
}

func TestParkTemplateParksWhenTheAgentBinaryIsMissing(t *testing.T) {
	parked := false

	_, err := parkTemplate(filepath.Join(t.TempDir(), "gone"), func() (*proto.Claim, error) {
		parked = true
		return &proto.Claim{}, nil
	})

	assert.NilError(t, err)
	assert.Check(t, parked)
}
