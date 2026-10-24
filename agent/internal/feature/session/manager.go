package session

import (
	"errors"
	"fmt"
	"log"
	"net"
	"regexp"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/launch"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const MaxSessions = 16

const killGrace = 2 * time.Second

// the host checks the same rule
var NamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type Manager struct {
	launcher         *launch.Launcher
	bootID           string
	killGrace        time.Duration
	tapWait          time.Duration
	lastWriteTimeout time.Duration
	recorded         func(*proto.Previous)

	// starting serializes starts and guards seq, so a spawn needs no hold on mu.
	starting sync.Mutex
	seq      uint64
	mu       sync.Mutex
	sessions map[string]*session
	previous map[string]ended

	attached atomic.Int64
}

type ended struct {
	seq      uint64
	previous *proto.Previous
}

func NewManager(l *launch.Launcher, bootID string) *Manager {
	return &Manager{
		launcher:         l,
		bootID:           bootID,
		killGrace:        killGrace,
		tapWait:          tapWait,
		lastWriteTimeout: lastWriteTimeout,
		sessions:         make(map[string]*session),
		previous:         make(map[string]ended),
	}
}

func (m *Manager) Attached() int { return int(m.attached.Load()) }

func (m *Manager) List() []*proto.SessionInfo {
	m.mu.Lock()
	all := make([]*session, 0, len(m.sessions))
	for _, s := range m.sessions {
		all = append(all, s)
	}
	m.mu.Unlock()
	infos := make([]*proto.SessionInfo, 0, len(all))
	for _, s := range all {
		infos = append(infos, s.info())
	}
	slices.SortFunc(infos, func(a, b *proto.SessionInfo) int { return strings.Compare(a.Name, b.Name) })
	return infos
}

func (m *Manager) Kill(name string) error {
	m.mu.Lock()
	s, ok := m.sessions[name]
	if ok {
		delete(m.sessions, name)
	}
	m.mu.Unlock()
	if !ok {
		return m.noSession(name)
	}
	m.retire(s)
	if s.exited() {
		return nil
	}
	_ = s.proc.Signal(syscall.SIGHUP)
	safe.Go("session "+name+" kill", func() {
		select {
		case <-s.done:
		case <-time.After(m.killGrace):
			_ = s.proc.Signal(syscall.SIGKILL)
		}
	}, nil)
	return nil
}

func (m *Manager) Serve(req *proto.Request, conn net.Conn, r *proto.Reader, w *proto.Writer) error {
	if req.Op == proto.OpSessionTap {
		return m.serveTap(req, conn, r, w)
	}
	m.attached.Add(1)
	defer m.attached.Add(-1)

	v := newViewer(conn, w, m.lastWriteTimeout)
	safe.Go("session "+req.GetSession()+" writer", v.run, func() { conn.Close() })
	s, perr := m.attach(req, v)
	if perr != nil {
		v.stop(nil, false)
		<-v.done
		return proto.ReplyError(w, perr)
	}

	input(s, v, r)
	s.detach(v)
	conn.Close()
	<-v.done
	return nil
}

// A tap counts as no open connection: a logged session must not keep the
// imp awake.
func (m *Manager) serveTap(req *proto.Request, conn net.Conn, r *proto.Reader, w *proto.Writer) error {
	m.mu.Lock()
	s, ok := m.sessions[req.GetSession()]
	m.mu.Unlock()
	if !ok {
		return proto.ReplyError(w, m.noSession(req.GetSession()))
	}
	t := newViewer(conn, w, m.lastWriteTimeout)
	t.progress = s.tapProgress
	safe.Go("session "+req.GetSession()+" tap", t.run, func() { conn.Close() })
	if perr := s.tap(t, req.ResumeFrom); perr != nil {
		t.stop(nil, false)
		<-t.done
		return proto.ReplyError(w, perr)
	}
	for {
		if _, err := r.Next(); err != nil {
			break
		}
	}
	s.untap(t)
	conn.Close()
	<-t.done
	return nil
}

func (m *Manager) attach(req *proto.Request, v *viewer) (*session, *proto.Error) {
	for range 2 {
		s, created, perr := m.find(req)
		if perr != nil {
			return nil, perr
		}
		err := s.attach(v, uint16(req.GetCols()), uint16(req.GetRows()), created, req.ResumeFrom, m.previousOf(s.name))
		if err == nil {
			return s, nil
		}
		if !errors.Is(err, errOver) {
			return nil, err.(*proto.Error)
		}
		if req.Op != proto.OpExec {
			break
		}
	}
	return nil, m.noSession(req.GetSession())
}

func (m *Manager) find(req *proto.Request) (*session, bool, *proto.Error) {
	if !NamePattern.MatchString(req.GetSession()) {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("bad session name %q", req.GetSession())}
	}
	if req.Op == proto.OpSessionAttach {
		m.mu.Lock()
		s, ok := m.sessions[req.GetSession()]
		m.mu.Unlock()
		if !ok {
			return nil, false, m.noSession(req.GetSession())
		}
		return s, false, nil
	}
	if !req.GetTty() {
		return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: "a session needs a tty"}
	}
	m.starting.Lock()
	defer m.starting.Unlock()
	m.mu.Lock()
	s, ok := m.sessions[req.GetSession()]
	count := len(m.sessions)
	m.mu.Unlock()
	if ok && (!s.exited() || isResumeOf(req.ResumeFrom, s) && !s.over()) {
		if req.GetDropSysAdmin() && !s.dropSysAdmin {
			return nil, false, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("session %q runs with CAP_SYS_ADMIN", s.name)}
		}
		return s, false, nil
	}
	if ok {
		<-s.done
		m.retire(s)
	}
	if !ok && count >= MaxSessions {
		return nil, false, &proto.Error{Code: proto.ErrSessionCap, Message: fmt.Sprintf("this imp already has %d sessions", MaxSessions)}
	}
	p, master, err := m.launcher.StartPTY(req, nil)
	if err != nil {
		return nil, false, proto.StartError(err, errors.Is(err, proc.ErrDown))
	}
	m.seq++
	s = newSession(req.GetSession(), req, run{proc: p, master: master, generation: sysutil.RandomHex(16), seq: m.seq, bootID: m.bootID, tapWait: m.tapWait})
	s.onDelivered = func() { m.removeIfOver(s) }
	m.mu.Lock()
	m.sessions[s.name] = s
	m.mu.Unlock()
	safe.Go("session "+s.name, s.run, nil)
	return s, true, nil
}

func (m *Manager) removeIfOver(s *session) {
	if !s.over() {
		return
	}
	e := ended{seq: s.seq, previous: s.ended()}
	m.mu.Lock()
	current := m.sessions[s.name] == s
	if current {
		delete(m.sessions, s.name)
		m.keepLocked(s.name, e)
	}
	m.mu.Unlock()
	if current && m.recorded != nil {
		m.recorded(e.previous)
	}
}

func (m *Manager) retire(s *session) {
	select {
	case <-s.done:
		m.record(s)
	default:
		safe.Go("session "+s.name+" retire", func() {
			<-s.done
			m.record(s)
		}, nil)
	}
}

func (m *Manager) record(s *session) {
	e := ended{seq: s.seq, previous: s.ended()}
	m.keep(s.name, e)
	if m.recorded != nil {
		m.recorded(e.previous)
	}
}

func (m *Manager) keep(name string, e ended) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.keepLocked(name, e)
}

func (m *Manager) keepLocked(name string, e ended) {
	if cur, ok := m.previous[name]; ok && cur.seq > e.seq {
		return
	}
	m.previous[name] = e
	if len(m.previous) <= MaxSessions {
		return
	}
	oldest := name
	for other, o := range m.previous {
		if o.seq < m.previous[oldest].seq {
			oldest = other
		}
	}
	delete(m.previous, oldest)
}

func (m *Manager) previousOf(name string) *proto.Previous {
	m.mu.Lock()
	defer m.mu.Unlock()
	if e, ok := m.previous[name]; ok {
		return e.previous
	}
	return nil
}

func (m *Manager) noSession(name string) *proto.Error {
	return &proto.Error{
		Code:    proto.ErrNoSession,
		Message: fmt.Sprintf("no session %q", name),
		Data:    &proto.ErrorData{BootId: new(m.bootID), Previous: m.previousOf(name)},
	}
}

func isResumeOf(resume *proto.ResumeFrom, s *session) bool {
	return resume != nil && resume.GetExecutionGeneration() == s.generation
}

func input(s *session, v *viewer, r *proto.Reader) {
	// a nil StdinEOF: a tty has no EOF to give; the client sends ^D itself
	_ = proto.Dispatch(r, proto.Input{
		Stdin:  func(p []byte) { s.queueStdin(v, p) },
		Resize: func(cols, rows uint16) { s.resize(v, cols, rows) },
		Signal: func(sig syscall.Signal) { s.signal(v, sig) },
		Other:  func(t proto.Type) { log.Printf("session %s: ignoring %s frame", s.name, t) },
	})
}
