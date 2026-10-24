package exec

import (
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/launch"
	"github.com/zgeoff/impz/agent/internal/host/cgroup"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/pty"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// Background children that inherited stdout would otherwise hold the
// session open forever.
const drainGrace = 500 * time.Millisecond

const exitLinger = 2 * time.Second

// A vsock reset on snapshot restore drops the host connection. A process
// that ignores SIGHUP keeps running, but no longer counts as a session.
const hangupGrace = time.Second

// A child that stops reading stdin fills this queue, not the ordered frame
// reader, so RESIZE and SIGNAL frames behind it stay deliverable until the
// queue is full. Past that the reader blocks, which pushes back on the host.
const (
	stdinChunk       = 4 << 10
	stdinQueueChunks = 1024
)

type Manager struct {
	launcher                *launch.Launcher
	cgroups                 *cgroup.Tree
	strict                  bool
	active                  atomic.Int64
	drainGrace, hangupGrace time.Duration

	leafFailed sync.Once
}

func NewManager(l *launch.Launcher, cgroups *cgroup.Tree) *Manager {
	return &Manager{launcher: l, cgroups: cgroups, drainGrace: drainGrace, hangupGrace: hangupGrace}
}

func NewStrictManager(l *launch.Launcher, cgroups *cgroup.Tree) *Manager {
	return &Manager{launcher: l, cgroups: cgroups, strict: true, drainGrace: drainGrace, hangupGrace: hangupGrace}
}

func (m *Manager) Active() int { return int(m.active.Load()) }

func (m *Manager) Serve(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	m.active.Add(1)
	defer m.active.Add(-1)

	s, err := m.start(req)
	if err != nil {
		return proto.ReplyError(w, proto.StartError(err, errors.Is(err, proc.ErrDown)))
	}
	if s.group != nil {
		defer m.cgroups.Release(s.group)
	}
	abort := func() {
		s.close()
		_ = s.proc.Signal(syscall.SIGHUP)
	}
	defer func() {
		if v := recover(); v != nil {
			abort()
			panic(v)
		}
	}()
	started := &proto.Started{Pid: int32(s.proc.Pid)}
	if ms := s.stop.grace.Milliseconds(); ms > 0 {
		started.KillGraceMs = new(uint32(ms))
	}
	if err := w.WriteMessage(proto.TypeStarted, started); err != nil {
		_ = s.proc.Signal(syscall.SIGHUP)
	}

	var writer sync.WaitGroup
	writer.Add(1)
	safe.Go("exec stdin", func() {
		defer writer.Done()
		s.writeStdin()
	}, abort)
	var pumps sync.WaitGroup
	for _, o := range s.outputs {
		pumps.Add(1)
		safe.Go("exec output", func() {
			defer pumps.Done()
			pump(o.f, o.typ, w)
		}, abort)
	}
	hangup := make(chan struct{})
	safe.Go("exec input", func() {
		defer close(hangup)
		s.input(r)
	}, abort)

	var st reaper.Status
	select {
	case st = <-s.proc.Done:
	case <-hangup:
		select {
		case st = <-s.proc.Done:
		case <-time.After(m.hangupGrace):
			s.close()
			pumps.Wait()
			writer.Wait()
			return fmt.Errorf("pid %d: host hung up, process ignored SIGHUP; detaching", s.proc.Pid)
		}
	}
	s.exited.Store(true)
	// A command stopped by the host may leave group members that ignored
	// the signal (nohup). They go before the drain, so their last output
	// still reaches EOF and the host before EXIT.
	if deadline, ok := s.stop.due(); ok {
		if s.group != nil {
			killCgroup(s.group, s.proc, deadline)
		} else {
			killGroup(s.proc, deadline)
		}
	}
	for _, o := range s.outputs {
		_ = o.f.SetReadDeadline(time.Now().Add(m.drainGrace))
	}
	pumps.Wait()
	s.close()
	writer.Wait()

	err = w.WriteMessage(proto.TypeExit, proto.ExitOf(st.Code, int(st.Signal)))
	// The host closes once it has EXIT. Read until then: a host frame that
	// races the exit (stdin EOF) must not hit a closed socket, or the host
	// loses the EXIT frame to EPIPE.
	select {
	case <-hangup:
	case <-time.After(exitLinger):
	}
	return err
}

type output struct {
	f   *os.File
	typ proto.Type
}

type session struct {
	proc    *proc.Process
	group   *cgroup.Group
	tty     *os.File
	stdin   *os.File
	outputs []output
	exited  atomic.Bool
	stop    stopTimer
	mu      sync.Mutex

	stdinQ     chan []byte
	stdinEnded bool
	done       chan struct{}
	closeOnce  sync.Once
}

func (m *Manager) start(req *proto.Request) (*session, error) {
	s := &session{
		stdinQ: make(chan []byte, stdinQueueChunks),
		done:   make(chan struct{}),
		stop:   stopTimer{grace: killGrace(req)},
	}
	if req.GetTty() {
		group, err := m.ttyGroup()
		if err != nil {
			return nil, err
		}
		var dir *os.File
		if group != nil {
			dir = group.Dir()
		}
		p, master, err := m.launcher.StartPTY(req, dir)
		if err != nil {
			if group != nil {
				m.cgroups.Release(group)
			}
			return nil, err
		}
		s.proc, s.tty, s.group = p, master, group
		s.outputs = []output{{master, proto.TypeStdout}}
		return s, nil
	}

	spec, err := m.launcher.Spec(req)
	if err != nil {
		return nil, err
	}
	var pipes [3][2]*os.File
	for i := range pipes {
		r, w, err := os.Pipe()
		if err != nil {
			closeAll(pipes[:i])
			return nil, err
		}
		pipes[i] = [2]*os.File{r, w}
	}
	s.stdin = pipes[0][1]
	s.outputs = []output{{pipes[1][0], proto.TypeStdout}, {pipes[2][0], proto.TypeStderr}}
	spec.Files = []*os.File{pipes[0][0], pipes[1][1], pipes[2][1]}
	group, err := m.newGroup()
	if err != nil {
		closeAll(pipes[:])
		return nil, err
	}
	if group != nil {
		spec.Cgroup = group.Dir()
	}

	p, err := m.launcher.Start(spec)
	for _, f := range spec.Files {
		f.Close()
	}
	if err != nil {
		if group != nil {
			m.cgroups.Release(group)
		}
		s.close()
		return nil, err
	}
	if group != nil && !p.InCgroup {
		m.cgroups.Release(group)
		group = nil
	}
	s.proc, s.group = p, group
	return s, nil
}

func (m *Manager) newGroup() (*cgroup.Group, error) {
	if m.cgroups == nil {
		if m.strict {
			return nil, errors.New("no cgroup to run in")
		}
		return nil, nil
	}
	g, err := m.cgroups.New()
	if err != nil {
		if m.strict {
			return nil, fmt.Errorf("cgroup: %w", err)
		}
		m.leafFailed.Do(func() {
			log.Printf("exec: no cgroup for execs (%v); a stop reaches only the process group", err)
		})
		return nil, nil
	}
	return g, nil
}

// Only a strict manager gives a tty exec a leaf: its process group belongs
// to the terminal, so no stop sweeps it.
func (m *Manager) ttyGroup() (*cgroup.Group, error) {
	if !m.strict {
		return nil, nil
	}
	return m.newGroup()
}

func (s *session) input(r *proto.Reader) {
	_ = proto.Dispatch(r, proto.Input{
		// Once the session ends the stdin goes nowhere, but the loop
		// reads on: a host frame that meets a closed socket loses the
		// host the EXIT frame to EPIPE.
		Stdin: s.queueStdin,
		StdinEOF: func() {
			// A tty has no EOF to give; the client sends ^D itself.
			if s.tty == nil {
				s.endStdin()
			}
		},
		Resize: func(cols, rows uint16) {
			if s.tty != nil {
				_ = pty.SetWinsize(s.tty, cols, rows)
			}
		},
		Signal: func(sig syscall.Signal) {
			if !s.exited.Load() {
				s.stop.arm(sig)
				_ = s.proc.Signal(sig)
			}
		},
		Other: func(t proto.Type) { log.Printf("exec: ignoring %s frame", t) },
	})
	if !s.exited.Load() {
		_ = s.proc.Signal(syscall.SIGHUP)
	}
	s.endStdin()
}

func (s *session) queueStdin(p []byte) {
	if s.stdinEnded {
		return
	}
	for len(p) > 0 {
		n := min(len(p), stdinChunk)
		select {
		case <-s.done:
			return
		default:
		}
		select {
		case s.stdinQ <- p[:n]:
		case <-s.done:
			return
		}
		p = p[n:]
	}
}

func (s *session) endStdin() {
	if !s.stdinEnded {
		s.stdinEnded = true
		close(s.stdinQ)
	}
}

func (s *session) writeStdin() {
	w := s.stdinWriter()
	for {
		select {
		case p, ok := <-s.stdinQ:
			if !ok {
				s.closeStdin()
				return
			}
			if w != nil {
				if _, err := w.Write(p); err != nil {
					w = nil
				}
			}
		case <-s.done:
			return
		}
	}
}

func (s *session) stdinWriter() io.Writer {
	if s.tty != nil {
		return s.tty
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin == nil {
		return nil
	}
	return s.stdin
}

func (s *session) closeStdin() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stdin != nil {
		s.stdin.Close()
		s.stdin = nil
	}
}

func (s *session) close() {
	s.closeOnce.Do(func() { close(s.done) })
	s.closeStdin()
	for _, o := range s.outputs {
		o.f.Close()
	}
}

// A pty read ends with EIO, not EOF, once its slave side is fully closed.
func pump(f *os.File, typ proto.Type, w *proto.Writer) {
	buf := make([]byte, 32<<10)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if w.Write(typ, buf[:n]) != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func closeAll(pipes [][2]*os.File) {
	for _, p := range pipes {
		p[0].Close()
		p[1].Close()
	}
}
