package boot

import (
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestCacheFileLeavesEveryPageOfTheFileInThePageCache(t *testing.T) {
	// tmpfs keeps every page resident, so the file lives on a disk
	dir, err := os.MkdirTemp("/var/tmp", "imp-cache-")
	assert.NilError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "agent")
	assert.NilError(t, os.WriteFile(path, make([]byte, 64*os.Getpagesize()), 0o644))
	f, err := os.Open(path)
	assert.NilError(t, err)
	defer f.Close()
	assert.NilError(t, f.Sync())
	assert.NilError(t, unix.Fadvise(int(f.Fd()), 0, 0, unix.FADV_DONTNEED))

	err = cacheFile(path)

	assert.NilError(t, err)
	mapped, err := unix.Mmap(int(f.Fd()), 0, 64*os.Getpagesize(), unix.PROT_READ, unix.MAP_SHARED)
	assert.NilError(t, err)
	defer unix.Munmap(mapped)
	resident := make([]byte, 64)
	_, _, errno := unix.Syscall(unix.SYS_MINCORE, uintptr(unsafe.Pointer(&mapped[0])), uintptr(len(mapped)), uintptr(unsafe.Pointer(&resident[0])))
	assert.Check(t, errno == 0, "mincore: %v", errno)
	missing := 0
	for _, page := range resident {
		if page&1 == 0 {
			missing++
		}
	}
	assert.Check(t, cmp.Equal(missing, 0))
}

func TestCacheFileReportsAFileThatIsMissing(t *testing.T) {
	err := cacheFile(filepath.Join(t.TempDir(), "gone"))

	assert.Check(t, os.IsNotExist(err))
}
