package main

import (
	"errors"
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

// memSource is the snapshot's memory file, mapped read-only. A hole reads as
// zeros, but a read through the mapping costs a page of page cache, so the
// handler copies a hole from a zero buffer and reads only the blocks that hold
// data.
type memSource struct {
	file   *os.File
	mapped []byte
}

func openMemSource(file *os.File) (*memSource, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("memory file: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return nil, fmt.Errorf("memory file: not a regular file with data (%s, %d bytes)", info.Mode(), info.Size())
	}
	mapped, err := unix.Mmap(int(file.Fd()), 0, int(info.Size()), unix.PROT_READ, unix.MAP_PRIVATE)
	if err != nil {
		return nil, fmt.Errorf("memory file: mmap: %w", err)
	}
	return &memSource{file: file, mapped: mapped}, nil
}

func (s *memSource) close() {
	_ = unix.Munmap(s.mapped)
	s.file.Close()
}

// readDataPages lists the offsets of the pageSize blocks that hold any data,
// by SEEK_DATA and SEEK_HOLE.
func (s *memSource) readDataPages(pageSize int64) (map[int64]bool, error) {
	fd := int(s.file.Fd())
	size := int64(len(s.mapped))
	pages := map[int64]bool{}
	var offset int64
	for offset < size {
		start, err := unix.Seek(fd, offset, unix.SEEK_DATA)
		if errors.Is(err, unix.ENXIO) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("memory file: SEEK_DATA: %w", err)
		}
		end, err := unix.Seek(fd, start, unix.SEEK_HOLE)
		if err != nil {
			return nil, fmt.Errorf("memory file: SEEK_HOLE: %w", err)
		}
		for page := start / pageSize * pageSize; page < end; page += pageSize {
			pages[page] = true
		}
		offset = end
	}
	return pages, nil
}
