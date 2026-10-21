// Package cgroup gives each exec a cgroup v2 leaf of its own, so a stop can
// kill every process the command started, including the ones that left its
// process group, with cgroup.kill and no pid-reuse window. A delegated tree
// also hands controllers down to each exec's cgroup, so its processes can
// make cgroups of their own with limits, such as a memory cap.
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
	// Root is where the guest mounts the cgroup2 hierarchy.
	Root = "/sys/fs/cgroup"

	// poll is how often a leaf is checked for members.
	poll = 20 * time.Millisecond

	// CommandLeaf is the cgroup a delegated exec's command starts in, under
	// the exec's own: a cgroup that hands controllers down takes no process.
	CommandLeaf = "command"
)

// Tree hands out numbered leaves under one parent cgroup, which holds no
// process itself, so the "no internal processes" rule never applies. The
// parent is a parameter: tests point it at a plain directory, and an inner
// container points it at its own subtree.
type Tree struct {
	parent string
	// prepare, if set, runs on the parent before each new leaf, so limits
	// set on it hold even after root removed it and it was made again
	prepare func(parent string) error
	// delegate, if set, is the subtree_control line that the parent and
	// each exec's cgroup get, such as "+memory"
	delegate string

	mu   sync.Mutex
	next uint64
	// delegateFailing holds whether the last delegation failed, so a
	// failure logs once when it starts, not on each exec
	delegateFailing bool
	// ended holds the leaves of sessions that are over but still had a
	// member (a nohup child, say) when they ended. Only these are swept:
	// a live session's leaf may be empty because its child is not yet
	// cloned into it.
	ended map[string]struct{}
}

// NewTree makes parent if needed and checks that leaves can be made in it.
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

// NewLimitedTree is NewTree with prepare, which sets the parent's limits:
// now, and again before each new leaf. A leaf whose prepare fails is not
// made.
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

// NewDelegatedTree is NewTree whose leaves hand controllers down: the parent
// and each exec's cgroup enable them, and the command starts in CommandLeaf
// under the exec's cgroup. A process of the exec can then make a cgroup next
// to CommandLeaf, set its limits and move into it, and a stop still kills it.
// A cgroup that cannot enable them still gets its leaf, without limits.
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

// Group is one exec's cgroup, and the leaf its command starts in: the same
// cgroup in a tree that delegates nothing.
type Group struct {
	path string
	dir  *os.File
	// waitEmptyRead, when set, sees each read WaitEmpty makes; nil outside
	// tests, which use it to know a read happened
	waitEmptyRead func(populated bool, err error)
}

// New sweeps the ended leaves that have emptied, then makes and opens a new
// leaf.
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

// enableDelegated writes the delegated controllers to dir's subtree_control.
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

// Release ends g's session: its cgroup, with every cgroup under it, goes now
// if it is empty, or at a later sweep once its last member exits.
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

// removeCgroup removes dir and the cgroups under it, deepest first. rmdir
// takes an empty cgroup with its files, and refuses one with members or
// children. The cgroups a member still holds stay, and so does dir.
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

// Dir is the leaf's directory fd, for clone3's CLONE_INTO_CGROUP.
func (g *Group) Dir() *os.File { return g.dir }

// Kill SIGKILLs every process in the leaf and its descendants.
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

// WaitEmpty polls cgroup.events until it says "populated 0" or deadline
// passes, and reports whether the leaf emptied.
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

// Populated reports whether the cgroup at dir or any cgroup under it holds a
// process, as its cgroup.events says.
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

// EnableControllers hands every controller of the cgroup at dir down to its
// children. It fails only when it cannot read the controllers: one the
// kernel refuses must not stop a boot, so a refused write is logged after
// logPrefix.
func EnableControllers(dir, logPrefix string) error {
	return changeControllers(dir, "cgroup.controllers", "+", "enable", logPrefix)
}

// DisableControllers takes back every controller the cgroup at dir hands
// down. It logs a refused write after logPrefix.
func DisableControllers(dir, logPrefix string) {
	_ = changeControllers(dir, "cgroup.subtree_control", "-", "disable", logPrefix)
}

// changeControllers writes each controller that dir's file from lists to
// dir's subtree_control, after op.
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
