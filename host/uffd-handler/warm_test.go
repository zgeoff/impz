package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
)

// writeSleptMemFile writes a memory file of three 2 MiB blocks whose first and
// last hold data and whose middle is a hole, on disk so its pages can leave
// the page cache.
func writeSleptMemFile(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("/var/tmp", "uffd-warm-")
	assert.NilError(t, err)
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "mem")
	file, err := os.Create(path)
	assert.NilError(t, err)
	defer file.Close()
	assert.NilError(t, file.Truncate(3*warmBlock))
	_, err = file.WriteAt(bytesOf('a', testPage), 0)
	assert.NilError(t, err)
	_, err = file.WriteAt(bytesOf('c', testPage), 2*warmBlock)
	assert.NilError(t, err)
	assert.NilError(t, file.Sync())
	assert.NilError(t, unix.Fadvise(int(file.Fd()), 0, 0, unix.FADV_DONTNEED))
	return path
}

// countCachedPages counts the pages of each 2 MiB block that the page cache
// holds.
func countCachedPages(t *testing.T, path string) []int {
	t.Helper()
	file, err := os.Open(path)
	assert.NilError(t, err)
	defer file.Close()
	info, err := file.Stat()
	assert.NilError(t, err)
	mapped, err := unix.Mmap(int(file.Fd()), 0, int(info.Size()), unix.PROT_READ, unix.MAP_SHARED)
	assert.NilError(t, err)
	defer unix.Munmap(mapped)
	pageSize := os.Getpagesize()
	resident := make([]byte, len(mapped)/pageSize)
	_, _, errno := unix.Syscall(unix.SYS_MINCORE, uintptr(unsafe.Pointer(&mapped[0])), uintptr(len(mapped)), uintptr(unsafe.Pointer(&resident[0])))
	assert.Equal(t, errno, unix.Errno(0))
	perBlock := warmBlock / pageSize
	counts := make([]int, len(resident)/perBlock)
	for page, flags := range resident {
		counts[page/perBlock] += int(flags & 1)
	}
	return counts
}

func TestRunWarmReadsEachDataBlockIntoThePageCache(t *testing.T) {
	path := writeSleptMemFile(t)
	perBlock := warmBlock / os.Getpagesize()
	var out bytes.Buffer

	err := runWarm(warm, path, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":2}\n")
	cached := countCachedPages(t, path)
	assert.DeepEqual(t, []int{cached[0], cached[2]}, []int{perBlock, perBlock})
}

func TestRunWarmCountsTheDataBlocksWithNoRead(t *testing.T) {
	path := writeSleptMemFile(t)
	var out bytes.Buffer

	err := runWarm(countData, path, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":2}\n")
	assert.DeepEqual(t, countCachedPages(t, path), []int{0, 0, 0})
}

func TestRunWarmRefusesAMissingMemoryFile(t *testing.T) {
	var out bytes.Buffer

	err := runWarm(warm, filepath.Join(t.TempDir(), "mem"), &out)

	assert.ErrorContains(t, err, "memory file:")
	assert.Equal(t, out.String(), "")
}

func TestParseWarmModeReadsAModeAndAPath(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		mode warmMode
		path string
		ok   bool
	}{
		{"the warm", []string{"--warm", "/data/mem"}, warm, "/data/mem", true},
		{"the count", []string{"--count-data", "/data/mem"}, countData, "/data/mem", true},
		{"a serve", []string{"--socket", "/run/uffd.sock"}, "", "", false},
		{"a mode with no path", []string{"--warm"}, "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mode, path, ok := parseWarmMode(tc.args)

			assert.Equal(t, mode, tc.mode)
			assert.Equal(t, path, tc.path)
			assert.Equal(t, ok, tc.ok)
		})
	}
}
