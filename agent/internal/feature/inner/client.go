package inner

import (
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
)

var ErrDown = proc.ErrDown

// A request that hangs (a stat on a dead FUSE mount, say) fails instead of
// holding its caller.
const callTimeout = 30 * time.Second

var errNoAnswer = errors.New("the inner init did not answer")

type pendingCall struct {
	ch       chan result
	register func(reply message)
}

type result struct {
	m   message
	err error
}

type client struct {
	sock        int
	callTimeout time.Duration

	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  uint64
	pending map[uint64]*pendingCall
	waiters map[int]chan reaper.Status
	closed  bool
	down    chan struct{}
}

func newClient(sock int) *client {
	return &client{
		sock:        sock,
		callTimeout: callTimeout,
		pending:     make(map[uint64]*pendingCall),
		waiters:     make(map[int]chan reaper.Status),
		down:        make(chan struct{}),
	}
}

func (c *client) waitReady() error {
	m, fds, err := recv(c.sock, make([]byte, 4096))
	sysutil.CloseFds(fds)
	if err != nil {
		return err
	}
	if m.Op != opReady {
		return fmt.Errorf("the inner init said %q before it was ready", m.Op)
	}
	return nil
}

func (c *client) run() {
	defer unix.Close(c.sock)
	defer c.shut()
	buf := newBuffer()
	for {
		m, fds, err := recv(c.sock, buf)
		sysutil.CloseFds(fds)
		if err != nil {
			if !errors.Is(err, errClosed) {
				log.Printf("inner: read: %v", err)
			}
			return
		}
		switch m.Op {
		case opReply:
			c.mu.Lock()
			call := c.pending[m.ID]
			delete(c.pending, m.ID)
			c.mu.Unlock()
			if call == nil {
				c.late(m)
				continue
			}
			if call.register != nil && m.Error == "" && m.Errno == 0 {
				call.register(m)
			}
			call.ch <- result{m: m}
		case opExit:
			c.mu.Lock()
			ch := c.waiters[m.Pid]
			delete(c.waiters, m.Pid)
			c.mu.Unlock()
			if ch != nil {
				ch <- statusOf(m)
			}
		}
	}
}

func (c *client) late(m message) {
	if m.Pid <= 0 || m.Error != "" || m.Errno != 0 {
		return
	}
	log.Printf("inner: pid %d started after its spawn timed out; killing it", m.Pid)
	safe.Go("inner: kill late spawn", func() { _ = c.signal(m.Pid, syscall.SIGKILL, false) }, nil)
}

func statusOf(m message) reaper.Status {
	if m.Signal != 0 {
		return reaper.Status{Pid: m.Pid, Code: -1, Signal: syscall.Signal(m.Signal)}
	}
	return reaper.Status{Pid: m.Pid, Code: m.Code}
}

func (c *client) shut() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	pending, waiters := c.pending, c.waiters
	c.pending, c.waiters = map[uint64]*pendingCall{}, map[int]chan reaper.Status{}
	c.mu.Unlock()
	for _, call := range pending {
		call.ch <- result{err: ErrDown}
	}
	for pid, ch := range waiters {
		ch <- reaper.Status{Pid: pid, Code: -1, Signal: syscall.SIGKILL}
	}
	_ = unix.Shutdown(c.sock, unix.SHUT_RDWR)
	close(c.down)
}

func (c *client) call(m message, fds []int, register func(reply message)) (message, error) {
	ch := make(chan result, 1)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return message{}, ErrDown
	}
	c.nextID++
	m.ID = c.nextID
	c.pending[m.ID] = &pendingCall{ch: ch, register: register}
	c.mu.Unlock()

	c.writeMu.Lock()
	err := send(c.sock, m, fds)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, m.ID)
		c.mu.Unlock()
		return message{}, fmt.Errorf("%w: %v", ErrDown, err)
	}
	t := time.NewTimer(c.callTimeout)
	defer t.Stop()
	select {
	case r := <-ch:
		if r.err != nil {
			return r.m, r.err
		}
		return r.m, replyErr(r.m)
	case <-t.C:
	}
	c.mu.Lock()
	_, waiting := c.pending[m.ID]
	delete(c.pending, m.ID)
	c.mu.Unlock()
	if !waiting {
		r := <-ch
		if r.err != nil {
			return r.m, r.err
		}
		return r.m, replyErr(r.m)
	}
	return message{}, fmt.Errorf("%s: %w after %s", m.Op, errNoAnswer, c.callTimeout)
}

// The pid is the process's pid in the container's PID namespace.
func (c *client) Start(s proc.Spec) (*proc.Process, error) {
	fds := make([]int, 0, len(s.Files)+1)
	for _, f := range s.Files {
		fds = append(fds, int(f.Fd()))
	}
	if s.Cgroup != nil {
		fds = append(fds, int(s.Cgroup.Fd()))
	}
	done := make(chan reaper.Status, 1)
	// The exit can only follow the reply on the socket; the read loop
	// registers the waiter before it reads on.
	reply, err := c.call(message{Op: opSpawn, Spec: toWire(s)}, fds, func(reply message) {
		c.mu.Lock()
		if c.closed {
			done <- reaper.Status{Pid: reply.Pid, Code: -1, Signal: syscall.SIGKILL}
		} else {
			c.waiters[reply.Pid] = done
		}
		c.mu.Unlock()
	})
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Argv[0], err)
	}
	p := proc.NewProcess(reply.Pid, done, c.signal)
	p.InCgroup = reply.InCgroup
	return p, nil
}

func (c *client) signal(pid int, sig syscall.Signal, group bool) error {
	_, err := c.call(message{Op: opSignal, Pid: pid, Sig: int(sig), Group: group}, nil, nil)
	if errors.Is(err, ErrDown) {
		// nothing is left in a dead container
		return syscall.ESRCH
	}
	return err
}

func (c *client) Down() <-chan struct{} { return c.down }

type initProc struct {
	pid        int
	sock       int
	signalKill func() error
	release    func()
	gone       chan struct{}
	status     reaper.Status
	killOnce   sync.Once
}

func newInitProc(pid, sock int, died <-chan reaper.Status, signalKill func() error, release func()) *initProc {
	p := &initProc{pid: pid, sock: sock, signalKill: signalKill, release: release, gone: make(chan struct{})}
	safe.Go("inner: reap", func() {
		p.status = <-died
		close(p.gone)
	}, nil)
	return p
}

func (p *initProc) kill() {
	p.killOnce.Do(func() {
		select {
		case <-p.gone:
		default:
			if err := p.signalKill(); err != nil && !errors.Is(err, unix.ESRCH) {
				log.Printf("inner: kill the init: %v", err)
			}
			<-p.gone
		}
		p.release()
	})
}

func startInit(r *reaper.Reaper, agent string, cloneflags uintptr, cgroup *os.File, env []string) (*initProc, error) {
	pair, err := newSocketpair()
	if err != nil {
		return nil, fmt.Errorf("socketpair: %w", err)
	}
	devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		unix.Close(pair[0])
		unix.Close(pair[1])
		return nil, err
	}
	defer devnull.Close()
	pidfd := -1
	sys := &syscall.SysProcAttr{Cloneflags: cloneflags, PidFD: &pidfd}
	if cgroup != nil {
		sys.UseCgroupFD = true
		sys.CgroupFD = int(cgroup.Fd())
	}
	attr := &syscall.ProcAttr{
		Dir:   "/",
		Env:   env,
		Files: []uintptr{devnull.Fd(), os.Stderr.Fd(), os.Stderr.Fd(), uintptr(pair[1])},
		Sys:   sys,
	}
	pid, done, err := r.Start(func() (int, error) {
		return syscall.ForkExec(agent, []string{agent, Command}, attr)
	})
	unix.Close(pair[1])
	if err != nil {
		unix.Close(pair[0])
		return nil, fmt.Errorf("start the inner init: %w", err)
	}
	return newInitProc(pid, pair[0], done,
		func() error { return unix.PidfdSendSignal(pidfd, unix.SIGKILL, nil, 0) },
		func() { unix.Close(pidfd) }), nil
}

const readyTimeout = 30 * time.Second

func connect(p *initProc, timeout time.Duration) (*client, error) {
	c := newClient(p.sock)
	ready := make(chan error, 1)
	safe.Go("inner: ready", func() { ready <- c.waitReady() }, func() { ready <- errors.New("panic") })
	var err error
	read := false
	select {
	case err = <-ready:
		if err == nil {
			safe.Go("inner: socket", c.run, c.shut)
			return c, nil
		}
		read = true
	case <-p.gone:
		err = fmt.Errorf("the inner init exited before it was ready: %s", describe(p.status))
	case <-time.After(timeout):
		err = fmt.Errorf("the inner init was not ready after %s", timeout)
	}
	p.kill()
	if !read {
		// the read must end before the fd number can go to another socket
		_ = unix.Shutdown(p.sock, unix.SHUT_RDWR)
		<-ready //nolint:errcheck // the wait ends the read; err already holds why connect failed
	}
	unix.Close(p.sock)
	return nil, err
}

func describe(st reaper.Status) string {
	if st.Signal != 0 {
		return "signal " + st.Signal.String()
	}
	return fmt.Sprintf("exit %d", st.Code)
}
