package main

import (
	"cmp"
	"encoding/binary"
	"fmt"
	"os"
	"slices"

	"golang.org/x/sys/unix"
)

// touchedEntry is the bytes that the touched file holds per 2 MiB block of the
// memory file: a little-endian uint32, 0 for a block that no fault was served
// from, and otherwise the 1-based order in which this handler's run first
// served a fault from the block.
const touchedEntry = 4

// touchedBlocks records, in that file, each block that a fault of this
// handler's run was served from and in what order. impd keeps the file past
// the run, so the next sleep's warm reads those blocks first-fault first. The
// file is a shared mapping, so a mark survives the handler's death and costs
// the fault path no system call.
type touchedBlocks struct {
	mapped []byte
	// the ordinal that the next first fault takes
	next uint32
}

// blockCount is how many warmBlock blocks a memory file of size bytes spans.
func blockCount(size int64) int64 {
	return (size + warmBlock - 1) / warmBlock
}

// openTouchedBlocks sizes the file to the memory file's blocks, zeroed, and
// maps it.
func openTouchedBlocks(file *os.File, memSize int64) (*touchedBlocks, error) {
	defer file.Close()
	size := blockCount(memSize) * touchedEntry
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
	return &touchedBlocks{mapped: mapped, next: 1}, nil
}

func (t *touchedBlocks) close() {
	if t != nil {
		_ = unix.Munmap(t.mapped)
	}
}

// mark records that the memory file's block holding offset was served, in the
// next ordinal when it is the block's first fault. A later fault keeps the
// block's ordinal.
func (t *touchedBlocks) mark(offset int64) {
	if t == nil {
		return
	}
	block := offset / warmBlock
	if block >= int64(len(t.mapped))/touchedEntry {
		return
	}
	entry := t.mapped[block*touchedEntry : (block+1)*touchedEntry]
	if binary.LittleEndian.Uint32(entry) != 0 {
		return
	}
	binary.LittleEndian.PutUint32(entry, t.next)
	t.next++
}

// readTouchedBlocks lists the offsets of the blocks that the file at path
// marks, in the order of their first fault. A file whose size is not
// touchedEntry bytes per block of the memory file is not that file's record,
// so it is refused: so is the one-byte-per-block file that an earlier version
// wrote.
func readTouchedBlocks(path string, memSize int64) ([]int64, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("block list: %w", err)
	}
	blocks := blockCount(memSize)
	if int64(len(raw)) != blocks*touchedEntry {
		return nil, fmt.Errorf("block list: %d bytes, but the memory file's %d blocks need %d", len(raw), blocks, blocks*touchedEntry)
	}
	type served struct {
		ordinal uint32
		offset  int64
	}
	var marked []served
	for block := range blocks {
		if ordinal := binary.LittleEndian.Uint32(raw[block*touchedEntry:]); ordinal != 0 {
			marked = append(marked, served{ordinal: ordinal, offset: block * warmBlock})
		}
	}
	slices.SortFunc(marked, func(a, b served) int {
		return cmp.Or(cmp.Compare(a.ordinal, b.ordinal), cmp.Compare(a.offset, b.offset))
	})
	offsets := make([]int64, len(marked))
	for i, entry := range marked {
		offsets[i] = entry.offset
	}
	return offsets, nil
}
