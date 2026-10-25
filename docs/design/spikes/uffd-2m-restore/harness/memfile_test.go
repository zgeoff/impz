package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
)

func TestDigHolesPunchesOutTheZeroBlocks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mem")
	content := make([]byte, 6*holeChunk)
	copy(content[holeChunk:], bytesOf('x', 10))
	copy(content[4*holeChunk+100:], bytesOf('y', 10))
	assert.NilError(t, os.WriteFile(path, content, 0o600))

	assert.NilError(t, digHoles(path))
	pages, err := readDataPages(path, holeChunk)
	assert.NilError(t, err)
	after, err := os.ReadFile(path)
	assert.NilError(t, err)

	assert.DeepEqual(t, pages, []int64{holeChunk, 4 * holeChunk})
	assert.DeepEqual(t, after, content)
}

func TestReadDataPagesRoundsDataOutToWholePages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mem")
	file, err := os.Create(path)
	assert.NilError(t, err)
	t.Cleanup(func() { file.Close() })
	assert.NilError(t, file.Truncate(8<<20))
	_, err = file.WriteAt(bytesOf('a', holeChunk), (2<<20)+holeChunk)
	assert.NilError(t, err)
	_, err = file.WriteAt(bytesOf('b', 2*holeChunk), (6<<20)-holeChunk)
	assert.NilError(t, err)

	pages, err := readDataPages(path, 2<<20)

	assert.NilError(t, err)
	assert.DeepEqual(t, pages, []int64{2 << 20, 4 << 20, 6 << 20})
}

func TestCopySparseCopiesTheDataAndTheSize(t *testing.T) {
	dir := t.TempDir()
	from := filepath.Join(dir, "disk")
	file, err := os.Create(from)
	assert.NilError(t, err)
	t.Cleanup(func() { file.Close() })
	assert.NilError(t, file.Truncate(8<<20))
	_, err = file.WriteAt(bytesOf('d', 4096), 3<<20)
	assert.NilError(t, err)
	to := filepath.Join(dir, "copy")

	assert.NilError(t, copySparse(from, to))
	want, err := os.ReadFile(from)
	assert.NilError(t, err)
	got, err := os.ReadFile(to)
	assert.NilError(t, err)

	assert.Equal(t, len(got), 8<<20)
	// go-cmp walks a byte slice one element at a time
	assert.Assert(t, bytes.Equal(got, want))
}

func TestWorkingSetKeepsEachPageOnceInOrder(t *testing.T) {
	path := filepath.Join(t.TempDir(), "ws.json")
	var ws workingSet
	ws.add(4096, []int64{8192, 0})
	ws.add(4096, []int64{4096, 8192})

	assert.NilError(t, ws.write(path))
	read, err := readWorkingSet(path)

	assert.NilError(t, err)
	assert.DeepEqual(t, read, workingSet{PageSize: 4096, Pages: []int64{0, 4096, 8192}})
}
