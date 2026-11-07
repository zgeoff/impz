package main

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
)

// warmBlock is the page the guest's memory is served in on the 2 MiB path,
// so it is the block a wake reads from the memory file.
const warmBlock = 2 << 20

// warmMode is how impd runs the handler for a slept imp's memory file:
// countData only lists its data blocks, and warm also reads each one through
// a map of the file, so the page cache holds it at the next wake.
type warmMode string

const (
	countData warmMode = "--count-data"
	warm      warmMode = "--warm"
)

type warmReport struct {
	Blocks int `json:"blocks"`
}

// warmSink keeps each read: the compiler may drop a load whose value goes
// nowhere.
var warmSink byte

func parseWarmMode(args []string) (warmMode, string, bool) {
	if len(args) != 2 {
		return "", "", false
	}
	mode := warmMode(args[0])
	if mode != countData && mode != warm {
		return "", "", false
	}
	return mode, args[1], true
}

// runWarm writes one JSON line with the file's data blocks to out.
func runWarm(mode warmMode, path string, out io.Writer) error {
	file, err := os.Open(path)
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
	if mode == warm {
		source.readThroughMap(blocks, os.Getpagesize())
	}
	return json.NewEncoder(out).Encode(warmReport{Blocks: len(blocks)})
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
	warmSink = sum
}
