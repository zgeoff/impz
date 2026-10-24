package inner

import (
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/host/cgroup"
	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/proc"
)

const (
	CgroupDir     = cgroup.Root + "/user"
	ExecCgroupDir = CgroupDir + "/exec"
)

const (
	minBackoff    = time.Second
	maxBackoff    = 30 * time.Second
	maxBadStarts  = 5
	restartWindow = 10 * time.Minute
	stableAfter   = time.Minute
	killWait      = 5 * time.Second
)

type Manager struct {
	cfg          Config
	cgroupDir    string
	startInit    func(cgroup *os.File) (*initProc, error)
	rootOf       func(pid int) string
	firstBackoff time.Duration
	readyTimeout time.Duration
	early        chan readyInit

	mu       sync.Mutex
	current  *client
	init     *initProc
	rootMu   sync.RWMutex
	root     *fsroot.Root
	restarts int
	bad      badStarts
	lastErr  string
	stopped  bool
	onDown   []func()
	onUp     []func()
	watching sync.WaitGroup
	stopCh   chan struct{}
}

func New(r *reaper.Reaper, cfg Config) *Manager {
	return &Manager{
		stopCh:       make(chan struct{}),
		cfg:          cfg,
		cgroupDir:    CgroupDir,
		firstBackoff: minBackoff,
		readyTimeout: readyTimeout,
		startInit: func(cgroup *os.File) (*initProc, error) {
			return startInit(r, AgentBinary,
				syscall.CLONE_NEWNS|syscall.CLONE_NEWPID|syscall.CLONE_NEWCGROUP, cgroup, cfg.env())
		},
		rootOf: func(pid int) string { return fmt.Sprintf("/proc/%d/root", pid) },
	}
}

func (m *Manager) Launch() {
	if err := m.startOnce(); err != nil {
		log.Printf("inner: %v", err)
		safe.Go("inner: restart", m.restartLoop, nil)
	}
}

func (m *Manager) OnDown(fn func()) {
	m.mu.Lock()
	m.onDown = append(m.onDown, fn)
	m.mu.Unlock()
}

func (m *Manager) OnUp(fn func()) {
	m.mu.Lock()
	m.onUp = append(m.onUp, fn)
	m.mu.Unlock()
}

func (m *Manager) startOnce() error {
	err := m.tryStart()
	if err != nil {
		m.mu.Lock()
		m.bad.add(time.Now())
		m.lastErr = err.Error()
		m.mu.Unlock()
	}
	return err
}

func (m *Manager) Prestart() {
	early := make(chan readyInit, 1)
	m.early = early
	safe.Go("inner: prestart", func() {
		p, c, err := m.startReady()
		early <- readyInit{p, c, err}
	}, func() { early <- readyInit{err: errors.New("panic")} })
}

type readyInit struct {
	p   *initProc
	c   *client
	err error
}

func (m *Manager) tryStart() error {
	p, c, err := m.takeReady()
	if err != nil {
		return err
	}
	root, err := fsroot.Open(m.rootOf(p.pid))
	if err != nil {
		c.shut()
		p.kill()
		m.cleanCgroup()
		return fmt.Errorf("open the container's root: %w", err)
	}
	m.rootMu.Lock()
	m.root = root
	m.rootMu.Unlock()
	m.mu.Lock()
	m.current, m.init, m.lastErr = c, p, ""
	stopped := m.stopped
	m.mu.Unlock()
	log.Printf("inner: up, init pid %d", p.pid)
	started := time.Now()
	m.watching.Add(1)
	safe.Go("inner: watch", func() {
		defer m.watching.Done()
		m.watch(c, p, started)
	}, nil)
	if stopped {
		p.kill()
	}
	return nil
}

func (m *Manager) takeReady() (*initProc, *client, error) {
	if early := m.early; early != nil {
		m.early = nil
		r := <-early
		return r.p, r.c, r.err
	}
	return m.startReady()
}

func (m *Manager) startReady() (*initProc, *client, error) {
	// what a container left behind (a cgroup that outlived the last wait,
	// say) must not fail this one
	m.cleanCgroup()
	cg, err := os.Open(m.cgroupDir)
	if err != nil {
		return nil, nil, fmt.Errorf("open %s: %w", m.cgroupDir, err)
	}
	defer cg.Close()
	p, err := m.startInit(cg)
	if err != nil {
		return nil, nil, err
	}
	c, err := connect(p, m.readyTimeout)
	if err != nil {
		m.cleanCgroup()
		return nil, nil, err
	}
	return p, c, nil
}

func (m *Manager) watch(c *client, p *initProc, started time.Time) {
	select {
	case <-p.gone:
		log.Printf("inner: the init died (%s)", describe(p.status))
		c.shut()
	case <-c.Down():
		log.Printf("inner: the socket closed")
	}
	p.kill()
	m.cleanCgroup()
	m.mu.Lock()
	if m.current == c {
		m.current, m.init = nil, nil
	}
	if time.Since(started) < stableAfter {
		m.bad.add(time.Now())
	}
	stopped := m.stopped
	downs := append([]func(){}, m.onDown...)
	m.mu.Unlock()
	m.rootMu.Lock()
	if m.root != nil {
		m.root.Close()
		m.root = nil
	}
	m.rootMu.Unlock()
	for _, fn := range downs {
		safe.Call("inner: on down", fn)
	}
	if !stopped {
		m.restartLoop()
	}
}

type badStarts []time.Time

func (b *badStarts) add(t time.Time) { *b = append(*b, t) }

func (b *badStarts) exhausted(now time.Time) bool {
	kept := (*b)[:0]
	for _, t := range *b {
		if now.Sub(t) < restartWindow {
			kept = append(kept, t)
		}
	}
	*b = kept
	return len(kept) > maxBadStarts
}

func (m *Manager) restartLoop() {
	backoff := m.firstBackoff
	for {
		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		if m.bad.exhausted(time.Now()) {
			m.lastErr = fmt.Sprintf("gave up after %d bad starts in %s: %s", len(m.bad), restartWindow, m.lastErr)
			log.Printf("inner: %s", m.lastErr)
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()

		select {
		case <-time.After(backoff):
		case <-m.stopCh:
			return
		}
		backoff = min(backoff*2, maxBackoff)

		m.mu.Lock()
		if m.stopped {
			m.mu.Unlock()
			return
		}
		m.restarts++
		m.mu.Unlock()
		if err := m.startOnce(); err != nil {
			log.Printf("inner: restart: %v", err)
			continue
		}
		m.mu.Lock()
		ups := append([]func(){}, m.onUp...)
		m.mu.Unlock()
		for _, fn := range ups {
			safe.Call("inner: on up", fn)
		}
		return
	}
}

func (m *Manager) Start(s proc.Spec) (*proc.Process, error) {
	m.mu.Lock()
	c := m.current
	m.mu.Unlock()
	if c == nil {
		return nil, ErrDown
	}
	return c.Start(s)
}

type Status struct {
	Up       bool
	Restarts int
	LastErr  string
}

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return Status{Up: m.current != nil, Restarts: m.restarts, LastErr: m.lastErr}
}

func (m *Manager) InitPid() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.init == nil {
		return 0
	}
	return m.init.pid
}

func (m *Manager) Stop() {
	m.mu.Lock()
	if !m.stopped {
		close(m.stopCh)
	}
	m.stopped = true
	p := m.init
	m.mu.Unlock()
	if p != nil {
		p.kill()
	}
	m.watching.Wait()
}

func (m *Manager) Root() fsroot.FS { return liveRoot{m} }

func (m *Manager) withRoot(fn func(r *fsroot.Root) error) error {
	m.rootMu.RLock()
	defer m.rootMu.RUnlock()
	if m.root == nil {
		return ErrDown
	}
	return fn(m.root)
}

func (c Config) env() []string {
	if c.RunSize == "" {
		return []string{}
	}
	return []string{runSizeEnv + "=" + c.RunSize}
}

// Not cgroup.kill: on the guest kernel (6.1) a clone3 with CLONE_INTO_CGROUP
// into a cgroup once killed got SIGKILL before it could exec. The init's
// death ends every process in the namespace instead.
func (m *Manager) cleanCgroup() {
	deadline := time.Now().Add(killWait)
	for populated(m.cgroupDir) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if populated(m.cgroupDir) {
		log.Printf("inner: processes outlived the init by %s", killWait)
		return
	}
	removeChildren(m.cgroupDir)
	if err := os.Mkdir(filepath.Join(m.cgroupDir, "exec"), 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
		log.Printf("inner: %v", err)
	}
	// a cgroup that hands controllers down takes no process, so the next
	// init could not start in it (EBUSY)
	cgroup.DisableControllers(m.cgroupDir, "inner: ")
}

func populated(dir string) bool {
	p, _ := cgroup.Populated(dir)
	return p
}

func removeChildren(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		if !e.IsDir() {
			continue
		}
		child := filepath.Join(dir, e.Name())
		removeChildren(child)
		if err := os.Remove(child); err != nil {
			log.Printf("inner: remove %s: %v", child, err)
		}
	}
}

type liveRoot struct{ m *Manager }

func (l liveRoot) with(fn func(r *fsroot.Root) error) error { return l.m.withRoot(fn) }

func (l liveRoot) OpenFile(p string, flag int, perm os.FileMode) (f *os.File, err error) {
	err = l.with(func(r *fsroot.Root) error { f, err = r.OpenFile(p, flag, perm); return err })
	return f, err
}

func (l liveRoot) ReadFile(p string) (b []byte, err error) {
	err = l.with(func(r *fsroot.Root) error { b, err = r.ReadFile(p); return err })
	return b, err
}

func (l liveRoot) ReadDir(p string) (ents []fs.DirEntry, err error) {
	err = l.with(func(r *fsroot.Root) error { ents, err = r.ReadDir(p); return err })
	return ents, err
}

func (l liveRoot) Stat(p string) (fi fs.FileInfo, err error) {
	err = l.with(func(r *fsroot.Root) error { fi, err = r.Stat(p); return err })
	return fi, err
}

func (l liveRoot) Lstat(p string) (fi fs.FileInfo, err error) {
	err = l.with(func(r *fsroot.Root) error { fi, err = r.Lstat(p); return err })
	return fi, err
}

func (l liveRoot) MkdirAll(p string, perm os.FileMode) error {
	return l.with(func(r *fsroot.Root) error { return r.MkdirAll(p, perm) })
}

func (l liveRoot) Rename(o, n string) error {
	return l.with(func(r *fsroot.Root) error { return r.Rename(o, n) })
}

func (l liveRoot) Remove(p string) error {
	return l.with(func(r *fsroot.Root) error { return r.Remove(p) })
}

func (l liveRoot) RemoveAll(p string) error {
	return l.with(func(r *fsroot.Root) error { return r.RemoveAll(p) })
}

func (l liveRoot) Truncate(p string, size int64) error {
	return l.with(func(r *fsroot.Root) error { return r.Truncate(p, size) })
}

func (l liveRoot) Lchown(p string, uid, gid int) error {
	return l.with(func(r *fsroot.Root) error { return r.Lchown(p, uid, gid) })
}

func (l liveRoot) Chmod(p string, mode os.FileMode) error {
	return l.with(func(r *fsroot.Root) error { return r.Chmod(p, mode) })
}

func (l liveRoot) Dir(p string) (f *os.File, err error) {
	err = l.with(func(r *fsroot.Root) error { f, err = r.Dir(p); return err })
	return f, err
}
