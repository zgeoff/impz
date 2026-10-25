package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"slices"

	"golang.org/x/sys/unix"
)

const holeChunk = 4096

// digHoles punches out every zero 4 KiB block of a file, as impd's
// `fallocate --dig-holes` does to a template's memory file.
func digHoles(path string) error {
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer file.Close()

	zero := make([]byte, holeChunk)
	buf := make([]byte, holeChunk)
	runStart := int64(-1)
	punch := func(end int64) error {
		if runStart < 0 {
			return nil
		}
		err := unix.Fallocate(int(file.Fd()), unix.FALLOC_FL_PUNCH_HOLE|unix.FALLOC_FL_KEEP_SIZE, runStart, end-runStart)
		runStart = -1
		return err
	}

	var offset int64
	for {
		n, err := io.ReadFull(file, buf)
		if n > 0 {
			if n == holeChunk && bytes.Equal(buf, zero) {
				if runStart < 0 {
					runStart = offset
				}
			} else if err := punch(offset); err != nil {
				return err
			}
			offset += int64(n)
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return punch(offset)
		}
		if err != nil {
			return err
		}
	}
}

// readDataPages lists the offsets of the pageSize blocks of a file that hold
// any data, by SEEK_DATA and SEEK_HOLE.
func readDataPages(path string, pageSize int64) ([]int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}

	fd := int(file.Fd())
	var pages []int64
	var offset int64
	for offset < info.Size() {
		start, err := unix.Seek(fd, offset, unix.SEEK_DATA)
		if errors.Is(err, unix.ENXIO) {
			break
		}
		if err != nil {
			return nil, err
		}
		end, err := unix.Seek(fd, start, unix.SEEK_HOLE)
		if err != nil {
			return nil, err
		}
		for page := start / pageSize * pageSize; page < end; page += pageSize {
			if len(pages) == 0 || pages[len(pages)-1] != page {
				pages = append(pages, page)
			}
		}
		offset = end
	}
	return pages, nil
}

// copySparse copies a disk image block by block over its data only, so a
// fresh copy of a 32 GiB sparse disk costs what its data costs. A clone is
// tried first, where the filesystem has one.
func copySparse(from, to string) error {
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	dst, err := os.OpenFile(to, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer dst.Close()

	if unix.IoctlFileClone(int(dst.Fd()), int(src.Fd())) == nil {
		return nil
	}

	pages, err := readDataPages(from, 1<<20)
	if err != nil {
		return err
	}
	buf := make([]byte, 1<<20)
	for _, page := range pages {
		n, err := src.ReadAt(buf, page)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if _, err := dst.WriteAt(buf[:n], page); err != nil {
			return err
		}
	}
	return dst.Truncate(info.Size())
}

// workingSet is the union of the memory-file pages that recorded boots
// faulted in, which a filling handler copies in before the resume.
type workingSet struct {
	PageSize int64   `json:"page_size"`
	Pages    []int64 `json:"pages"`
}

func (ws *workingSet) add(pageSize int64, pages []int64) {
	ws.PageSize = pageSize
	ws.Pages = append(ws.Pages, pages...)
	slices.Sort(ws.Pages)
	ws.Pages = slices.Compact(ws.Pages)
}

func (ws workingSet) write(path string) error {
	encoded, err := json.Marshal(ws)
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o600)
}

func readWorkingSet(path string) (workingSet, error) {
	var ws workingSet
	encoded, err := os.ReadFile(path) //nolint:gosec // G703: the operator names the working-set file
	if err != nil {
		return ws, err
	}
	return ws, json.Unmarshal(encoded, &ws)
}
