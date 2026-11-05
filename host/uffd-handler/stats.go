package main

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// stats_layout.go numbers the fields, from stats-layout.json. impd reads the
// file while the handler runs, so each count is one aligned store.
const statsSize = statsFields * 8

type copyResult int

const (
	copyRetry copyResult = iota
	copiedHole
	copiedData
)

// handlerStats counts in the stats file through a shared mapping, which costs
// the fault path no system call.
type handlerStats struct {
	mapped []byte
}

func openHandlerStats(file *os.File) (*handlerStats, error) {
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("stats file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() != statsSize {
		return nil, fmt.Errorf("stats file: not a regular file of %d bytes (%s, %d bytes)", statsSize, info.Mode(), info.Size())
	}
	mapped, err := unix.Mmap(int(file.Fd()), 0, statsSize, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_SHARED)
	if err != nil {
		return nil, fmt.Errorf("stats file: mmap: %w", err)
	}
	return &handlerStats{mapped: mapped}, nil
}

func (s *handlerStats) close() {
	_ = unix.Munmap(s.mapped)
}

// record counts one try at a fault: its time always, and the fault and its
// block only once a copy served it.
func (s *handlerStats) record(result copyResult, elapsed time.Duration) {
	s.add(statsServeNs, uint64(elapsed.Nanoseconds()))
	switch result {
	case copiedHole:
		s.add(statsFaults, 1)
	case copiedData:
		s.add(statsFaults, 1)
		s.add(statsBlocks, 1)
	}
}

// Both of the handler's architectures, amd64 and arm64, store a uint64
// little-endian.
func (s *handlerStats) add(field int, delta uint64) {
	atomic.AddUint64((*uint64)(unsafe.Pointer(&s.mapped[field*8])), delta)
}
