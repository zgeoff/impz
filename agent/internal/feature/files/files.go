// The inner container sees this tree on a read-only bind, so a process
// inside, root included, gets EROFS on every write
// (docs/architecture/guest/agent.md#read-only-files).
package files

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"regexp"
	"strings"
	"syscall"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const (
	Dir  = "/run/files"
	Size = "16m"

	// one file's content must fit a frame as base64
	MaxData = 512 << 10

	maxSegments = 8
	maxPath     = 512
)

// A segment never starts with a dot, so no path names a staged file. impd
// checks the same rule.
var SegmentRule = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`)

type Store struct {
	dir string
}

func New(dir string) *Store {
	return &Store{dir: dir}
}

// The rename means a reader sees the old content or the new and never part
// of either.
func (s *Store) Write(p string, data []byte) error {
	if err := checkPath(p); err != nil {
		return err
	}
	if len(data) > MaxData {
		return badRequest("data is %d bytes, over the %d byte cap", len(data), MaxData)
	}
	root, err := fsroot.Open(s.dir)
	if err != nil {
		return err
	}
	defer root.Close()
	dir, name := path.Split("/" + p)
	if dir != "/" {
		if err := root.MkdirAll(strings.TrimSuffix(dir, "/"), 0o755); err != nil {
			return mapErr(err)
		}
	}
	if fi, err := root.Lstat("/" + p); err == nil && !fi.Mode().IsRegular() {
		return badRequest("%s is not a regular file", p)
	}
	staged := dir + "." + name + "." + sysutil.RandomHex(8)
	if err := writeStaged(root, staged, data); err != nil {
		_ = root.Remove(staged)
		return mapErr(err)
	}
	if err := root.Rename(staged, "/"+p); err != nil {
		_ = root.Remove(staged)
		return mapErr(err)
	}
	return nil
}

func (s *Store) Remove(p string) (bool, error) {
	if err := checkPath(p); err != nil {
		return false, err
	}
	root, err := fsroot.Open(s.dir)
	if err != nil {
		return false, err
	}
	defer root.Close()
	fi, err := root.Lstat("/" + p)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ENOTDIR) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !fi.Mode().IsRegular() {
		return false, badRequest("%s is not a regular file", p)
	}
	// a remove beside this one may take the file first
	err = root.Remove("/" + p)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func checkPath(p string) error {
	if p == "" || len(p) > maxPath {
		return badRequest("path must be 1 to %d bytes", maxPath)
	}
	parts := strings.Split(p, "/")
	if len(parts) > maxSegments {
		return badRequest("path has more than %d segments", maxSegments)
	}
	for _, part := range parts {
		if !SegmentRule.MatchString(part) {
			return badRequest("path segment %q is not allowed", part)
		}
	}
	return nil
}

func writeStaged(root *fsroot.Root, staged string, data []byte) error {
	f, err := root.OpenFile(staged, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o444)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	// past the umask
	if err := f.Chmod(0o444); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func mapErr(err error) error {
	switch {
	case errors.Is(err, syscall.ENOSPC):
		return &proto.Error{Code: proto.ErrNoSpace, Message: fmt.Sprintf("the read-only files are full (%s): %v", Size, err)}
	case errors.Is(err, syscall.ENOTDIR), errors.Is(err, syscall.EISDIR), errors.Is(err, fs.ErrExist):
		return badRequest("%v", err)
	}
	return err
}

func badRequest(format string, args ...any) error {
	return &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf(format, args...)}
}
