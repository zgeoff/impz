package services

import (
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"time"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/host/fsroot"
)

const (
	maxLogSize  = 10 << 20
	rotateEvery = time.Minute
)

func rotateLog(fsys fsroot.FS, path string) error {
	if !oversize(fsys, path) {
		return nil
	}
	return fsys.Rename(path, path+".1")
}

// The running service keeps its fd, opened O_APPEND, so its next write lands
// at the new end. Lines written between the copy and the truncate are lost,
// the usual copytruncate trade.
func (s *Supervisor) copyTruncateLog(path string) error {
	if !oversize(s.fsys, path) {
		return nil
	}
	src, err := s.fsys.OpenFile(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer src.Close()
	tmp := path + ".1.tmp"
	dst, err := s.fsys.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close()
		_ = s.fsys.Remove(tmp)
		return err
	}
	if err := dst.Close(); err != nil {
		_ = s.fsys.Remove(tmp)
		return err
	}
	if err := s.fsys.Rename(tmp, path+".1"); err != nil {
		return err
	}
	s.truncMu.Lock()
	defer s.truncMu.Unlock()
	if err := s.fsys.Truncate(path, 0); err != nil {
		return err
	}
	s.truncs[path]++
	return nil
}

func (s *Supervisor) readLogState(path string) (uint64, os.FileInfo, error) {
	s.truncMu.Lock()
	defer s.truncMu.Unlock()
	fi, err := s.fsys.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return s.truncs[path], nil, nil
	}
	return s.truncs[path], fi, err
}

func oversize(fsys fsroot.FS, path string) bool {
	fi, err := fsys.Stat(path)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			log.Printf("services: %v", err)
		}
		return false
	}
	return fi.Size() > maxLogSize
}

func (s *Supervisor) rotateLogs(quit <-chan struct{}) {
	t := time.NewTicker(rotateEvery)
	defer t.Stop()
	for {
		select {
		case <-quit:
			return
		case <-t.C:
		}
		safe.Call("services: log rotator", s.rotateAll)
	}
}

func (s *Supervisor) rotateAll() {
	s.mu.Lock()
	svcs := make([]*service, 0, len(s.services))
	for _, svc := range s.services {
		svcs = append(svcs, svc)
	}
	s.mu.Unlock()
	for _, svc := range svcs {
		func() {
			svc.logMu.Lock()
			defer svc.logMu.Unlock()
			if err := s.copyTruncateLog(s.logPath(svc)); err != nil {
				log.Printf("services: %s: rotate log: %v", svc.def.GetName(), err)
			}
		}()
	}
}
