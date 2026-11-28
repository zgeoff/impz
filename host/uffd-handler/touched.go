package main

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// touchedBlocks marks, in a file of one byte per 2 MiB block of the memory
// file, each block that a fault of this handler's run was served from. impd
// keeps the file past the run, so the next sleep's warm reads only those
// blocks. The file is a shared mapping, so a mark survives the handler's
// death and costs the fault path no system call.
type touchedBlocks struct {
	mapped []byte
}

// blockCount is how many warmBlock blocks a memory file of size bytes spans.
func blockCount(size int64) int64 {
	return (size + warmBlock - 1) / warmBlock
}

// openTouchedBlocks sizes the file to the memory file's blocks, zeroed, and
// maps it.
func openTouchedBlocks(file *os.File, memSize int64) (*touchedBlocks, error) {
	defer file.Close()
	size := blockCount(memSize)
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("touched file: %w", err)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("touched file: not a regular file (%s)", info.Mode())
	}
	if err := file.Truncate(0); err != nil {
		return nil, fmt.Errorf("touched file: %w", err)
	}
	if err := file.Truncate(size); err != nil {
		return nil, fmt.Errorf("touched file: %w", err)
	}
	mapped, err := unix.Mmap(int(file.Fd()), 0, int(size), unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		return nil, fmt.Errorf("touched file: mmap: %w", err)
	}
	return &touchedBlocks{mapped: mapped}, nil
}

func (t *touchedBlocks) close() {
	if t != nil {
		_ = unix.Munmap(t.mapped)
	}
}

// mark records that the memory file's block holding offset was served.
func (t *touchedBlocks) mark(offset int64) {
	if t == nil {
		return
	}
	if block := offset / warmBlock; block < int64(len(t.mapped)) {
		t.mapped[block] = 1
	}
}

// readTouchedBlocks lists the offsets of the blocks that the file at path
// marks. A file shorter or longer than the memory file's blocks is not that
// file's set, so it is refused.
func readTouchedBlocks(path string, memSize int64) (map[int64]bool, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // G304: impd passes the block list it recorded, not input
	if err != nil {
		return nil, fmt.Errorf("block list: %w", err)
	}
	if int64(len(raw)) != blockCount(memSize) {
		return nil, fmt.Errorf("block list: %d blocks, but the memory file has %d", len(raw), blockCount(memSize))
	}
	blocks := map[int64]bool{}
	for block, mark := range raw {
		if mark != 0 {
			blocks[int64(block)*warmBlock] = true
		}
	}
	return blocks, nil
}
