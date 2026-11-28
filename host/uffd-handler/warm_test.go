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

	err := runWarm(warmRequest{mode: warm, memFile: path}, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":2}\n")
	cached := countCachedPages(t, path)
	assert.DeepEqual(t, []int{cached[0], cached[2]}, []int{perBlock, perBlock})
}

func TestRunWarmCountsTheDataBlocksWithNoRead(t *testing.T) {
	path := writeSleptMemFile(t)
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: countData, memFile: path}, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":2}\n")
	assert.DeepEqual(t, countCachedPages(t, path), []int{0, 0, 0})
}

func TestRunWarmRefusesAMissingMemoryFile(t *testing.T) {
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: warm, memFile: filepath.Join(t.TempDir(), "mem")}, &out)

	assert.ErrorContains(t, err, "memory file:")
	assert.Equal(t, out.String(), "")
}

func TestParseWarmModeReadsAModeAndItsPaths(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want warmRequest
		ok   bool
	}{
		{"the warm", []string{"--warm", "/data/mem"}, warmRequest{mode: warm, memFile: "/data/mem"}, true},
		{"the count", []string{"--count-data", "/data/mem"}, warmRequest{mode: countData, memFile: "/data/mem"}, true},
		{"the warm of blocks", []string{"--warm-blocks", "/data/mem.touched", "/data/mem"}, warmRequest{mode: warmBlocks, blockList: "/data/mem.touched", memFile: "/data/mem"}, true},
		{"the count of blocks", []string{"--count-blocks", "/data/mem.touched", "/data/mem"}, warmRequest{mode: countBlocks, blockList: "/data/mem.touched", memFile: "/data/mem"}, true},
		{"a serve", []string{"--socket", "/run/uffd.sock"}, warmRequest{}, false},
		{"a mode with no path", []string{"--warm"}, warmRequest{}, false},
		{"a blocks mode with no list", []string{"--warm-blocks", "/data/mem"}, warmRequest{}, false},
		{"a whole-file mode with a list", []string{"--warm", "/data/mem.touched", "/data/mem"}, warmRequest{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseWarmMode(tc.args)

			assert.Equal(t, got, tc.want)
			assert.Equal(t, ok, tc.ok)
		})
	}
}

// writeBlockList writes the file impd keeps: a byte per block of the three
// block memory file, marked as given.
func writeBlockList(t *testing.T, marks ...byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mem.touched")
	assert.NilError(t, os.WriteFile(path, marks, 0o600))
	return path
}

func TestRunWarmOfBlocksReadsOnlyTheListedDataBlocks(t *testing.T) {
	path := writeSleptMemFile(t)
	perBlock := warmBlock / os.Getpagesize()
	// the middle block is a hole, so only the last of the two listed has data
	list := writeBlockList(t, 0, 1, 1)
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: warmBlocks, blockList: list, memFile: path}, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":1}\n")
	cached := countCachedPages(t, path)
	assert.DeepEqual(t, []int{cached[0], cached[2]}, []int{0, perBlock})
}

func TestRunCountBlocksCountsTheListedDataBlocksWithNoRead(t *testing.T) {
	path := writeSleptMemFile(t)
	list := writeBlockList(t, 1, 1, 0)
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: countBlocks, blockList: list, memFile: path}, &out)

	assert.NilError(t, err)
	assert.Equal(t, out.String(), "{\"blocks\":1}\n")
	assert.DeepEqual(t, countCachedPages(t, path), []int{0, 0, 0})
}

func TestRunWarmOfBlocksRefusesAListOfAnotherMemoryFile(t *testing.T) {
	path := writeSleptMemFile(t)
	list := writeBlockList(t, 1, 1)
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: warmBlocks, blockList: list, memFile: path}, &out)

	assert.ErrorContains(t, err, "block list: 2 blocks, but the memory file has 3")
	assert.Equal(t, out.String(), "")
}

func TestRunWarmOfBlocksRefusesAMissingList(t *testing.T) {
	path := writeSleptMemFile(t)
	var out bytes.Buffer

	err := runWarm(warmRequest{mode: warmBlocks, blockList: filepath.Join(t.TempDir(), "none"), memFile: path}, &out)

	assert.ErrorContains(t, err, "block list:")
}
