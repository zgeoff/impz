package services

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/proto"
	"golang.org/x/sys/unix"
)

const (
	MaxLogLines = 100_000
	tailBlock   = 64 << 10
	followEvery = 250 * time.Millisecond
)

type LogRequest struct {
	Lines  int
	Follow bool
	Cursor *proto.LogCursor
}

func (s *Supervisor) Logs(name string, req LogRequest, w *proto.Writer, done <-chan struct{}) error {
	if req.Lines < 0 || req.Lines > MaxLogLines {
		return badRequest("lines: want 0 to 100000")
	}
	path := filepath.Join(s.logDir, name+".log")
	if filepath.Base(path) != name+".log" || s.find(name) == nil && !exists(s.fsys, path) && !exists(s.fsys, path+".1") {
		return noService(name)
	}
	// opened before the reply, so what comes first and the follow meet at
	// the same offset for everything written after it
	cur, size, err := openLogFile(s.fsys, path)
	if err != nil {
		return err
	}
	if err := w.WriteMessage(proto.TypeResponse, &proto.OK{Ok: true}); err != nil {
		cur.close()
		return err
	}
	if req.Cursor != nil {
		err = sendFromCursor(s.fsys, path, cur, size, req.Cursor, w)
	} else {
		err = sendTail(s.fsys, path, cur, size, req.Lines, w)
	}
	if err != nil {
		cur.close()
		return err
	}
	if !req.Follow {
		cur.close()
		return w.Write(proto.TypeStdoutEOF, nil)
	}
	return s.followLog(path, cur, w, done)
}

type logFile struct {
	f      *os.File
	ino    uint64
	offset int64
}

func openLogFile(fsys fsroot.FS, path string) (*logFile, int64, error) {
	f, err := fsys.OpenFile(path, os.O_RDONLY|unix.O_NONBLOCK, 0)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	if err := fsroot.CheckRegular(f, path); err != nil {
		f.Close()
		return nil, 0, err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, err
	}
	return &logFile{f: f, ino: inodeOf(fi)}, fi.Size(), nil
}

func (lf *logFile) close() {
	if lf != nil {
		lf.f.Close()
	}
}

func (lf *logFile) send(end int64, w *proto.Writer) error {
	buf := make([]byte, tailBlock)
	for lf.offset < end {
		chunk := buf[:min(int64(len(buf)), end-lf.offset)]
		k, err := lf.f.ReadAt(chunk, lf.offset)
		if k > 0 {
			if err := w.Write(proto.TypeStdout, chunk[:k]); err != nil {
				return err
			}
			lf.offset += int64(k)
			if err := w.WriteMessage(proto.TypeCursor, &proto.LogCursor{Inode: float64(lf.ino), Offset: float64(lf.offset)}); err != nil {
				return err
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
	return nil
}

func sendTail(fsys fsroot.FS, path string, cur *logFile, size int64, n int, w *proto.Writer) error {
	start, found := int64(0), 0
	if cur != nil {
		start, found = findLastLines(cur.f, size, n)
	}
	if found < n {
		old, oldSize, err := openLogFile(fsys, path+".1")
		if err != nil {
			return err
		}
		if old != nil {
			old.offset, _ = findLastLines(old.f, oldSize, n-found)
			err := old.send(oldSize, w)
			old.close()
			if err != nil {
				return err
			}
		}
	}
	if cur == nil {
		return nil
	}
	cur.offset = start
	return cur.send(size, w)
}

func sendFromCursor(fsys fsroot.FS, path string, cur *logFile, size int64, c *proto.LogCursor, w *proto.Writer) error {
	ino, offset := uint64(c.GetInode()), int64(c.GetOffset())
	if cur != nil && cur.ino == ino {
		if offset >= 0 && offset <= size {
			cur.offset = offset
		}
		return cur.send(size, w)
	}
	old, oldSize, err := openLogFile(fsys, path+".1")
	if err != nil {
		return err
	}
	if old != nil && old.ino == ino {
		if offset >= 0 && offset <= oldSize {
			old.offset = offset
		}
		err = old.send(oldSize, w)
	}
	old.close()
	if err != nil || cur == nil {
		return err
	}
	return cur.send(size, w)
}

func findLastLines(f *os.File, size int64, n int) (int64, int) {
	if n == 0 || size == 0 {
		return size, 0
	}
	buf := make([]byte, tailBlock)
	end := size
	found := 0
	// the newline that ends the file ends the last line, not one before it
	skip := true
	for end > 0 {
		start := max(end-tailBlock, 0)
		chunk := buf[:end-start]
		if _, err := f.ReadAt(chunk, start); err != nil && !errors.Is(err, io.EOF) {
			return start, found
		}
		for i := len(chunk) - 1; i >= 0; i-- {
			if chunk[i] != '\n' {
				skip = false
				continue
			}
			if skip {
				skip = false
				continue
			}
			found++
			if found == n {
				return start + int64(i) + 1, found
			}
		}
		end = start
	}
	if !skip {
		found++
	}
	return 0, min(found, n)
}

func (s *Supervisor) followLog(path string, cur *logFile, w *proto.Writer, done <-chan struct{}) error {
	defer func() { cur.close() }()
	truncs, _, err := s.readLogState(path)
	if err != nil {
		return err
	}
	t := time.NewTicker(followEvery)
	defer t.Stop()
	for {
		select {
		case <-done:
			return nil
		case <-t.C:
		}
		now, fi, err := s.readLogState(path)
		if err != nil {
			return err
		}
		if cur != nil && (fi == nil || inodeOf(fi) != cur.ino) {
			if err := sendNew(cur, w); err != nil {
				return err
			}
			cur.close()
			cur = nil
		}
		if cur != nil && now != truncs {
			if err := sendCopyRest(s.fsys, path, cur.offset, w); err != nil {
				return err
			}
			cur.offset = 0
		}
		truncs = now
		if cur == nil && fi != nil {
			cur, _, err = openLogFile(s.fsys, path)
			if err != nil {
				return err
			}
		}
		if cur != nil {
			if err := sendNew(cur, w); err != nil {
				return err
			}
		}
	}
}

func sendCopyRest(fsys fsroot.FS, path string, offset int64, w *proto.Writer) error {
	old, size, err := openLogFile(fsys, path+".1")
	if err != nil || old == nil {
		return err
	}
	defer old.close()
	if offset > size {
		return nil
	}
	old.offset = offset
	return old.send(size, w)
}

func sendNew(cur *logFile, w *proto.Writer) error {
	fi, err := cur.f.Stat()
	if err != nil {
		return err
	}
	if fi.Size() < cur.offset {
		cur.offset = 0
	}
	return cur.send(fi.Size(), w)
}

func inodeOf(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}
