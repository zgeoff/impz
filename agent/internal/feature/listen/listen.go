package listen

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/dial"
	"github.com/zgeoff/impz/agent/internal/feature/inner"
	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// /run is a fresh tmpfs every boot, so a socket never outlives the boot it
// was made in.
const (
	AgentRoot   = "/run/imp/ssh-agent"
	ForwardRoot = "/run/imp/forward"
)

const (
	maxPending = 16

	pendingTimeout = 10 * time.Second

	agentSocket   = "agent.sock"
	forwardSocket = "sock"
)

type Binder interface {
	Listen(network, address string) (*dial.Bound, error)
}

type Manager struct {
	agentRoot, forwardRoot string

	image          *imagecfg.Live
	binder         Binder
	fsys           fsroot.FS
	pendingTimeout time.Duration

	mu        sync.Mutex
	listeners map[string]*listener
}

func NewManager(agentRoot, forwardRoot string, image *imagecfg.Live, binder Binder, fsys fsroot.FS) *Manager {
	return &Manager{
		agentRoot:      agentRoot,
		forwardRoot:    forwardRoot,
		image:          image,
		binder:         binder,
		fsys:           fsys,
		pendingTimeout: pendingTimeout,
		listeners:      map[string]*listener{},
	}
}

type listener struct {
	id string
	ln net.Listener
	w  *proto.Writer

	// a TCP port is open to every process in the guest, as an sshd remote
	// forward is
	checkPeer bool
	uid       uint32

	cleanup func()
	// a tmpfs goes when the container does
	inTmpfs bool

	pendingTimeout time.Duration

	mu      sync.Mutex
	next    uint32
	pending map[uint32]net.Conn
	closed  bool
}

func (m *Manager) ServeAgent(r *proto.Reader, w *proto.Writer) error {
	return m.serve(r, w, func(l *listener) (*proto.Listening, error) {
		return m.openOwn(l, m.agentRoot, agentSocket)
	})
}

func (m *Manager) Serve(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	switch {
	case req.GetNetwork() == "unix" && req.GetAddress() == "":
		return m.serve(r, w, func(l *listener) (*proto.Listening, error) {
			return m.openOwn(l, m.forwardRoot, forwardSocket)
		})
	case req.GetNetwork() == "unix" || req.GetNetwork() == "tcp":
		return m.serve(r, w, func(l *listener) (*proto.Listening, error) {
			return m.openBound(l, req.GetNetwork(), req.GetAddress())
		})
	default:
		return proto.ReplyError(w, &proto.Error{
			Code:    proto.ErrBadRequest,
			Message: fmt.Sprintf("network must be tcp or unix, got %q", req.GetNetwork()),
		})
	}
}

func (m *Manager) serve(r *proto.Reader, w *proto.Writer, open func(*listener) (*proto.Listening, error)) error {
	id := sysutil.RandomHex(8)
	l := &listener{id: id, w: w, pendingTimeout: m.pendingTimeout, pending: map[uint32]net.Conn{}}
	resp, err := open(l)
	if err != nil {
		return proto.ReplyError(w, err)
	}
	m.mu.Lock()
	m.listeners[id] = l
	m.mu.Unlock()
	defer m.close(l)

	resp.Ok, resp.Listener = true, id
	if err := w.WriteMessage(proto.TypeResponse, resp); err != nil {
		return err
	}

	accepted := make(chan error, 1)
	safe.Go("listen accept", func() {
		accepted <- l.serve()
	}, func() {
		accepted <- errors.New("listen accept panicked")
	})

	// The host sends nothing more; its close, or a vsock reset after a
	// forced sleep, ends the listener.
	hostDone := make(chan error, 1)
	safe.Go("listen host", func() {
		hostDone <- drain(r)
	}, func() {
		hostDone <- errors.New("listen host reader panicked")
	})

	select {
	case err := <-hostDone:
		return err
	case err := <-accepted:
		return err
	}
}

func (m *Manager) Accept(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	m.mu.Lock()
	l := m.listeners[req.GetListener()]
	m.mu.Unlock()

	var c net.Conn
	if l != nil {
		c = l.take(req.GetConnection())
	}
	if c == nil {
		return proto.ReplyError(w, &proto.Error{
			Code:    proto.ErrNoConnection,
			Message: fmt.Sprintf("no waiting connection %d on listener %q", req.GetConnection(), req.GetListener()),
		})
	}
	defer c.Close()
	if err := w.WriteMessage(proto.TypeResponse, &proto.OK{Ok: true}); err != nil {
		return err
	}
	return dial.Relay(c, r, w)
}

func (m *Manager) lookupUser() (uid, gid uint32, err error) {
	cred, _, err := proc.LookupUserIn(m.fsys, m.image.Get().User)
	if err != nil {
		return 0, 0, err
	}
	if cred == nil {
		return 0, 0, nil
	}
	return cred.Uid, cred.Gid, nil
}

// Both are made as root and handed to the user last, so nobody else can
// reach the socket in between. The bind goes through the directory's own fd,
// so a symlink planted on the way cannot move it.
func (m *Manager) openOwn(l *listener, root, name string) (*proto.Listening, error) {
	uid, gid, err := m.lookupUser()
	if err != nil {
		return nil, err
	}
	if err := m.fsys.MkdirAll(root, 0o755); err != nil {
		return nil, err
	}
	dir := filepath.Join(root, l.id)
	if err := m.fsys.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name)
	ln, err := m.listenOwn(l, path, dir, name, uid, gid)
	if err != nil {
		_ = m.fsys.RemoveAll(dir)
		return nil, err
	}
	l.ln, l.checkPeer, l.uid = ln, true, uid
	// a container that died took the directory along
	l.cleanup = func() {
		if err := m.fsys.RemoveAll(dir); err != nil && !errors.Is(err, inner.ErrDown) {
			log.Printf("listen: remove %s: %v", dir, err)
		}
	}
	return &proto.Listening{Path: new(path)}, nil
}

func (m *Manager) listenOwn(l *listener, path, dir, name string, uid, gid uint32) (net.Listener, error) {
	d, err := m.fsys.Dir(dir)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	l.inTmpfs = onTmpfs(int(d.Fd()))
	at := fmt.Sprintf("/proc/self/fd/%d/%s", d.Fd(), name)
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: at, Net: "unix"})
	if err != nil {
		return nil, err
	}
	ln.SetUnlinkOnClose(false)
	for _, step := range []func() error{
		func() error { return m.fsys.Chmod(path, 0o600) },
		func() error { return m.fsys.Lchown(path, int(uid), int(gid)) },
		func() error { return m.fsys.Lchown(dir, int(uid), int(gid)) },
	} {
		if err := step(); err != nil {
			ln.Close()
			return nil, err
		}
	}
	return ln, nil
}

// A socket file on a tmpfs, as /run and /dev are, went with a dead container.
// A TCP port lives in the guest's one network namespace, and a socket file on
// the user disk stays, so those listeners go on serving the next container.
func (m *Manager) CloseLost() {
	m.mu.Lock()
	var lost []*listener
	for _, l := range m.listeners {
		if l.inTmpfs {
			lost = append(lost, l)
		}
	}
	m.mu.Unlock()
	for _, l := range lost {
		m.close(l)
	}
}

// Every tmpfs the user reaches is a mount of the container, made again or
// gone at its next start. The fd, not the path, decides, so a link such as
// /var/run -> /run counts as what it leads to.
func onTmpfs(fd int) bool {
	var st unix.Statfs_t
	if err := unix.Fstatfs(fd, &st); err != nil {
		log.Printf("listen: statfs: %v", err)
		return false
	}
	return st.Type == unix.TMPFS_MAGIC
}

func (m *Manager) openBound(l *listener, network, address string) (*proto.Listening, error) {
	uid, _, err := m.lookupUser()
	if err != nil {
		return nil, err
	}
	b, err := m.binder.Listen(network, address)
	if err != nil {
		return nil, err
	}
	l.ln, l.checkPeer, l.uid = b.Listener, network == "unix", uid
	l.inTmpfs = network == "unix" && onTmpfs(b.Dir)
	l.cleanup = b.Close
	if network == "tcp" {
		return &proto.Listening{Port: new(uint32(b.Port))}, nil
	}
	return &proto.Listening{Path: new(filepath.Clean(address))}, nil
}

func (m *Manager) close(l *listener) {
	m.mu.Lock()
	delete(m.listeners, l.id)
	m.mu.Unlock()

	l.mu.Lock()
	l.closed = true
	for id, c := range l.pending {
		c.Close()
		delete(l.pending, id)
	}
	l.mu.Unlock()

	l.ln.Close()
	l.cleanup()
}

func (l *listener) serve() error {
	for {
		c, err := l.ln.Accept()
		if errors.Is(err, net.ErrClosed) {
			return nil
		}
		if err != nil {
			return err
		}
		if l.checkPeer && !l.allows(c) {
			c.Close()
			continue
		}
		id, ok := l.add(c)
		if !ok {
			c.Close()
			continue
		}
		if err := l.w.WriteMessage(proto.TypeConnection, &proto.Connection{Id: id}); err != nil {
			return err
		}
	}
}

// The modes already keep others out; this holds even if a mode is changed.
func (l *listener) allows(c net.Conn) bool {
	sc, ok := c.(syscall.Conn)
	if !ok {
		return false
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return false
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || credErr != nil {
		return false
	}
	return cred.Uid == l.uid || cred.Uid == 0
}

func (l *listener) add(c net.Conn) (uint32, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed || len(l.pending) >= maxPending {
		return 0, false
	}
	l.next++
	id := l.next
	l.pending[id] = c
	time.AfterFunc(l.pendingTimeout, func() {
		if c := l.take(id); c != nil {
			c.Close()
		}
	})
	return id, true
}

func (l *listener) take(id uint32) net.Conn {
	l.mu.Lock()
	defer l.mu.Unlock()
	c := l.pending[id]
	delete(l.pending, id)
	return c
}

func drain(r *proto.Reader) error {
	for {
		if _, err := r.Next(); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}
