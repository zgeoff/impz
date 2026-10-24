package cgroup

import (
	"bufio"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	Root = "/sys/fs/cgroup"

	poll = 20 * time.Millisecond

	// cgroup v2 puts no process in a cgroup that hands controllers down
	CommandLeaf = "command"
)

// The parent holds no process itself, so cgroup v2's "no internal processes"
// rule never applies.
type Tree struct {
	parent   string
	prepare  func(parent string) error
	delegate string

	mu              sync.Mutex
	next            uint64
	delegateFailing bool
	ended           map[string]struct{}
}

func NewTree(parent string) (*Tree, error) {
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return nil, err
	}
	probe, err := os.MkdirTemp(parent, ".probe-")
	if err != nil {
		return nil, err
	}
	if err := os.Remove(probe); err != nil {
		return nil, err
	}
	return &Tree{parent: parent, ended: map[string]struct{}{}}, nil
}

func NewLimitedTree(parent string, prepare func(parent string) error) (*Tree, error) {
	t, err := NewTree(parent)
	if err != nil {
		return nil, err
	}
	if err := prepare(parent); err != nil {
		return nil, err
	}
	t.prepare = prepare
	return t, nil
}

func NewDelegatedTree(parent string, controllers ...string) (*Tree, error) {
	t, err := NewTree(parent)
	if err != nil {
		return nil, err
	}
	enable := make([]string, 0, len(controllers))
	for _, c := range controllers {
		enable = append(enable, "+"+c)
	}
	t.delegate = strings.Join(enable, " ")
	t.enableDelegated(parent)
	return t, nil
}

type Group struct {
	path          string
	dir           *os.File
	waitEmptyRead func(populated bool, err error)
}

func (t *Tree) New() (*Group, error) {
	t.mu.Lock()
	t.sweepLocked()
	t.next++
	path := filepath.Join(t.parent, strconv.FormatUint(t.next, 10))
	t.mu.Unlock()

	// the parent again: in the inner container, root can remove it
	if err := os.MkdirAll(t.parent, 0o755); err != nil {
		return nil, err
	}
	if t.prepare != nil {
		if err := t.prepare(t.parent); err != nil {
			return nil, err
		}
	}
	if t.delegate != "" {
		// the parent again: the inner init enables the controllers above
		// it only once it runs, and a restart makes the parent anew
		t.enableDelegated(t.parent)
	}
	if err := os.Mkdir(path, 0o755); err != nil {
		return nil, err
	}
	leaf := path
	if t.delegate != "" {
		t.enableDelegated(path)
		leaf = filepath.Join(path, CommandLeaf)
		if err := os.Mkdir(leaf, 0o755); err != nil {
			os.Remove(path)
			return nil, err
		}
	}
	dir, err := os.OpenFile(leaf, os.O_RDONLY|syscall.O_DIRECTORY, 0)
	if err != nil {
		_ = removeCgroup(path)
		return nil, err
	}
	return &Group{path: path, dir: dir}, nil
}

func (t *Tree) enableDelegated(dir string) {
	// no O_CREATE: a directory without the file is no cgroup
	f, err := os.OpenFile(filepath.Join(dir, "cgroup.subtree_control"), os.O_WRONLY, 0)
	if err == nil {
		_, err = f.Write([]byte(t.delegate))
		if closeErr := f.Close(); err == nil {
			err = closeErr
		}
	}
	t.mu.Lock()
	started := err != nil && !t.delegateFailing
	t.delegateFailing = err != nil
	t.mu.Unlock()
	if started {
		log.Printf("cgroup: enable %s in %s: %v; an exec's processes cannot set its limits", t.delegate, dir, err)
	}
}

func (t *Tree) Release(g *Group) {
	g.dir.Close()
	if err := removeCgroup(g.path); err == nil || errors.Is(err, os.ErrNotExist) {
		return
	}
	t.mu.Lock()
	t.ended[g.path] = struct{}{}
	t.mu.Unlock()
}

func (t *Tree) sweepLocked() {
	for path := range t.ended {
		if err := removeCgroup(path); err == nil || errors.Is(err, os.ErrNotExist) {
			delete(t.ended, path)
		}
	}
}

// rmdir takes an empty cgroup with its files, and refuses one with members or
// children, so the removal goes deepest first.
func removeCgroup(dir string) error {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, e := range ents {
		if e.IsDir() {
			// a child that stays makes the removal of dir fail, which reports it
			_ = removeCgroup(filepath.Join(dir, e.Name()))
		}
	}
	return os.Remove(dir)
}

func (g *Group) Dir() *os.File { return g.dir }

// cgroup.kill reaches the processes that left the process group too, with no
// pid-reuse window.
func (g *Group) Kill() error {
	// no O_CREATE: a leaf without the file is no cgroup to kill
	f, err := os.OpenFile(filepath.Join(g.path, "cgroup.kill"), os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, err = f.Write([]byte("1"))
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (g *Group) WaitEmpty(deadline time.Time) bool {
	for {
		populated, err := Populated(g.path)
		if g.waitEmptyRead != nil {
			g.waitEmptyRead(populated, err)
		}
		if err == nil && !populated {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(min(poll, time.Until(deadline)))
	}
}

func Populated(dir string) (bool, error) {
	f, err := os.Open(filepath.Join(dir, "cgroup.events"))
	if err != nil {
		return false, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if value, ok := strings.CutPrefix(sc.Text(), "populated "); ok {
			return value != "0", nil
		}
	}
	if err := sc.Err(); err != nil {
		return false, err
	}
	return false, fmt.Errorf("%s: no populated line", dir)
}

func EnableControllers(dir, logPrefix string) error {
	return changeControllers(dir, "cgroup.controllers", "+", "enable", logPrefix)
}

func DisableControllers(dir, logPrefix string) {
	_ = changeControllers(dir, "cgroup.subtree_control", "-", "disable", logPrefix)
}

func changeControllers(dir, from, op, verb, logPrefix string) error {
	b, err := os.ReadFile(filepath.Join(dir, from))
	if err != nil {
		return err
	}
	var change []string
	for _, c := range strings.Fields(string(b)) {
		change = append(change, op+c)
	}
	if len(change) == 0 {
		return nil
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.subtree_control"), []byte(strings.Join(change, " ")), 0); err != nil { //nolint:gosec // G703: dir is a cgroup the agent made or mounted, not input
		log.Printf("%s%s %v: %v", logPrefix, verb, change, err)
	}
	return nil
}
