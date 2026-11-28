package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"runtime"
)

// warmBlock is the page the guest's memory is served in on the 2 MiB path,
// so it is the block a wake reads from the memory file.
const warmBlock = 2 << 20

// warmMode is how impd runs the handler for a slept imp's memory file:
// countData only lists its data blocks, and warm also reads each one through
// a map of the file, so the page cache holds it at the next wake. The two
// blocks modes take a list of the blocks that a wake served, and do the same
// for the data blocks on that list alone.
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
	memFile   string
}

type warmReport struct {
	Blocks int `json:"blocks"`
}

func parseWarmMode(args []string) (warmRequest, bool) {
	if len(args) == 2 && (warmMode(args[0]) == countData || warmMode(args[0]) == warm) {
		return warmRequest{mode: warmMode(args[0]), memFile: args[1]}, true
	}
	if len(args) == 3 && (warmMode(args[0]) == countBlocks || warmMode(args[0]) == warmBlocks) {
		return warmRequest{mode: warmMode(args[0]), blockList: args[1], memFile: args[2]}, true
	}
	return warmRequest{}, false
}

// runWarm writes one JSON line with the blocks it counted or read to out.
func runWarm(req warmRequest, out io.Writer) error {
	file, err := os.Open(req.memFile) //nolint:gosec // G703: impd passes the memory file of an imp it slept, not input
	if err != nil {
		return fmt.Errorf("memory file: %w", err)
	}
	source, err := openMemSource(file)
	if err != nil {
		file.Close()
		return err
	}
	defer source.close()
	blocks, err := source.readDataPages(warmBlock)
	if err != nil {
		return err
	}
	if req.mode == countBlocks || req.mode == warmBlocks {
		listed, err := readTouchedBlocks(req.blockList, int64(len(source.mapped)))
		if err != nil {
			return err
		}
		blocks = intersect(blocks, listed)
	}
	if req.mode == warm || req.mode == warmBlocks {
		source.readThroughMap(blocks, os.Getpagesize())
	}
	return json.NewEncoder(out).Encode(warmReport{Blocks: len(blocks)})
}

// intersect keeps the blocks of data that the list holds: a block of the list
// that is a hole in this file has nothing to read.
func intersect(data map[int64]bool, listed map[int64]bool) map[int64]bool {
	kept := map[int64]bool{}
	for offset := range listed {
		if data[offset] {
			kept[offset] = true
		}
	}
	return kept
}

// readThroughMap faults in each page of the blocks through the map, as the
// handler's copy at a wake does, so the same pages land in the page cache.
func (s *memSource) readThroughMap(blocks map[int64]bool, pageSize int) {
	size := int64(len(s.mapped))
	var sum byte
	for offset := range blocks {
		end := min(offset+warmBlock, size)
		for page := offset; page < end; page += int64(pageSize) {
			sum += s.mapped[page]
		}
	}
	// the compiler may drop a load whose value goes nowhere
	runtime.KeepAlive(sum)
}
