package main

import (
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"os"
	"runtime"
	"slices"
	"strconv"

	"golang.org/x/sys/unix"
)

// warmBlock is the page the guest's memory is served in on the 2 MiB path,
// so it is the block a wake reads from the memory file.
const warmBlock = 2 << 20

// warmMode is how impd runs the handler for a slept imp's memory file:
// countData only lists its data blocks, and warm also reads each one through
// a map of the file, so the page cache holds it at the next wake. The two
// blocks modes take the file of the blocks that a wake served, in the order of
// their first fault, and do the same for the data blocks on that list alone:
// --warm-blocks reads them in that order, and stops after its limit.
type warmMode string

const (
	countData   warmMode = "--count-data"
	warm        warmMode = "--warm"
	countBlocks warmMode = "--count-blocks"
	warmBlocks  warmMode = "--warm-blocks"
)

// warmRequest is one run of a warm mode.
type warmRequest struct {
	mode warmMode
	// the file of served blocks, for the blocks modes alone
	blockList string
	// how many blocks --warm-blocks reads at most, from the start of the list
	limit   int
	memFile string
}

type warmReport struct {
	Blocks int `json:"blocks"`
}

func parseWarmMode(args []string) (warmRequest, bool) {
	if len(args) == 2 && (warmMode(args[0]) == countData || warmMode(args[0]) == warm) {
		return warmRequest{mode: warmMode(args[0]), memFile: args[1]}, true
	}
	if len(args) == 3 && warmMode(args[0]) == countBlocks {
		return warmRequest{mode: countBlocks, blockList: args[1], memFile: args[2]}, true
	}
	if len(args) == 4 && warmMode(args[0]) == warmBlocks {
		limit, err := strconv.Atoi(args[3])
		if err != nil || limit < 1 {
			return warmRequest{}, false
		}
		return warmRequest{mode: warmBlocks, blockList: args[1], memFile: args[2], limit: limit}, true
	}
	return warmRequest{}, false
}

// runWarm writes one JSON line with the blocks it counted or read to out.
func runWarm(req warmRequest, out io.Writer) error {
	file, err := os.Open(req.memFile)
	if err != nil {
		return fmt.Errorf("memory file: %w", err)
	}
	source, err := openMemSource(file)
	if err != nil {
		file.Close()
		return err
	}
	defer source.close()
	data, err := source.readDataPages(warmBlock)
	if err != nil {
		return err
	}
	// the whole file reads from its start, and a list reads in its own order
	blocks := slices.Sorted(maps.Keys(data))
	if req.mode == countBlocks || req.mode == warmBlocks {
		listed, err := readTouchedBlocks(req.blockList, int64(len(source.mapped)))
		if err != nil {
			return err
		}
		blocks = intersect(data, listed)
	}
	if req.mode == warmBlocks {
		blocks = blocks[:min(len(blocks), req.limit)]
		// the kernel would read ahead into the blocks that the list leaves out
		if err := unix.Madvise(source.mapped, unix.MADV_RANDOM); err != nil {
			return fmt.Errorf("memory file: madvise: %w", err)
		}
	}
	if req.mode == warm || req.mode == warmBlocks {
		source.readThroughMap(blocks, os.Getpagesize())
	}
	return json.NewEncoder(out).Encode(warmReport{Blocks: len(blocks)})
}

// intersect keeps the blocks of the list that hold data, in the list's order:
// a block of the list that is a hole in this file has nothing to read.
func intersect(data map[int64]bool, listed []int64) []int64 {
	kept := make([]int64, 0, len(listed))
	for _, offset := range listed {
		if data[offset] {
			kept = append(kept, offset)
		}
	}
	return kept
}

// readThroughMap faults in each page of the blocks through the map, as the
// handler's copy at a wake does, so the same pages land in the page cache.
func (s *memSource) readThroughMap(blocks []int64, pageSize int) {
	size := int64(len(s.mapped))
	var sum byte
	for _, offset := range blocks {
		end := min(offset+warmBlock, size)
		for page := offset; page < end; page += int64(pageSize) {
			sum += s.mapped[page]
		}
	}
	// the compiler may drop a load whose value goes nowhere
	runtime.KeepAlive(sum)
}
