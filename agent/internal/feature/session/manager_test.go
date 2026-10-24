package session

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"google.golang.org/protobuf/reflect/protoreflect"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
	"gotest.tools/v3/poll"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/feature/launch"
	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// The reaper runs a process-wide wait4 loop, so the package shares one.
var testReaper *reaper.Reaper

func TestMain(m *testing.M) {
	testReaper = reaper.New()
	os.Exit(m.Run())
}

func newTestManager(t *testing.T, bootID string) *Manager {
	t.Helper()
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{Env: []string{"PATH=/usr/bin:/bin"}}), nil), bootID)
	t.Cleanup(func() {
		for _, s := range m.List() {
			m.Kill(s.Name)
			syscall.Kill(-int(s.Pid), syscall.SIGKILL)
		}
	})
	return m
}

type host struct {
	conn   net.Conn
	w      *proto.Writer
	frames chan proto.Frame
	served chan error
	out    bytes.Buffer
}

func connect(t *testing.T, m *Manager, req *proto.Request) *host {
	t.Helper()
	guest, conn := net.Pipe()
	return serve(t, m, req, guest, conn)
}

func runServe(t *testing.T, m *Manager, req *proto.Request, guest, conn net.Conn) chan error {
	t.Helper()
	served := make(chan error, 1)
	exited := make(chan struct{})
	t.Cleanup(func() {
		conn.Close()
		joined(t, exited, "Serve")
	})
	go func() {
		defer close(exited)
		served <- m.Serve(req, guest, proto.NewReader(guest), proto.NewWriter(guest))
		guest.Close()
	}()
	return served
}

func joined(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Errorf("%s did not end after the host closed", what)
	}
}

func serve(t *testing.T, m *Manager, req *proto.Request, guest, conn net.Conn) *host {
	t.Helper()
	h := &host{conn: conn, w: proto.NewWriter(conn), frames: make(chan proto.Frame, 1024)}
	h.served = runServe(t, m, req, guest, conn)
	read := make(chan struct{})
	// registered later, so it runs before the serve's cleanup, which closes
	// conn and ends the reader
	t.Cleanup(func() {
		conn.Close()
		joined(t, read, "the host's frame reader")
	})
	go func() {
		defer close(read)
		defer close(h.frames)
		r := proto.NewReader(conn)
		for {
			f, err := r.Next()
			if err != nil {
				return
			}
			h.frames <- f
		}
	}()
	return h
}

func start(t *testing.T, m *Manager, name, script string) *host {
	t.Helper()
	return connect(t, m, &proto.Request{Op: proto.OpExec, Session: new(name), Tty: new(true),
		Argv: []string{"sh", "-c", script}, Cols: new(uint32(80)), Rows: new(uint32(24))})
}

func attach(t *testing.T, m *Manager, name string) *host {
	t.Helper()
	return connect(t, m, &proto.Request{Op: proto.OpSessionAttach, Session: new(name), Cols: new(uint32(80)), Rows: new(uint32(24))})
}

func (h *host) next(t *testing.T) proto.Frame {
	t.Helper()
	select {
	case f, ok := <-h.frames:
		assert.Assert(t, ok, "connection closed")
		return f
	case <-time.After(5 * time.Second):
		t.Fatal("no frame within 5s")
		return proto.Frame{}
	}
}

func (h *host) started(t *testing.T) *proto.Started {
	t.Helper()
	f := h.next(t)
	assert.Equal(t, f.Type, proto.TypeStarted, "first frame %q", f.Payload)
	return decode[proto.Started](t, f)
}

func (h *host) until(t *testing.T, want string) {
	t.Helper()
	for !strings.Contains(h.out.String(), want) {
		f := h.next(t)
		assert.Equal(t, f.Type, proto.TypeStdout, "frame %q while waiting for %q in %q", f.Payload, want, h.out.String())
		h.out.Write(f.Payload)
	}
}

func (h *host) last(t *testing.T) proto.Frame {
	t.Helper()
	for {
		f := h.next(t)
		switch f.Type {
		case proto.TypeStdout:
			h.out.Write(f.Payload)
		case proto.TypeExit, proto.TypeDetached:
			return f
		default:
			t.Fatalf("unexpected %s frame", f.Type)
		}
	}
}

func (h *host) errorCode(t *testing.T) string {
	t.Helper()
	f := h.next(t)
	assert.Equal(t, f.Type, proto.TypeResponse, "frame %q", f.Payload)
	resp := decode[proto.ErrorResponse](t, f)
	assert.Assert(t, resp.Error != nil, "RESPONSE %q is no error", f.Payload)
	return resp.Error.Code
}

func (h *host) send(t *testing.T, typ proto.Type, payload []byte) {
	t.Helper()
	assert.NilError(t, h.w.Write(typ, payload))
}

func (h *host) detach(t *testing.T) {
	t.Helper()
	h.conn.Close()
	h.waitServed(t)
}

func (h *host) waitServed(t *testing.T) {
	t.Helper()
	select {
	case <-h.served:
	case <-time.After(5 * time.Second):
		t.Fatal("Serve did not return")
	}
}

func decode[T any, P interface {
	*T
	protoreflect.ProtoMessage
}](t *testing.T, f proto.Frame) P {
	t.Helper()
	v := P(new(T))
	assert.NilError(t, proto.Unmarshal(f.Payload, v), "%s frame %q", f.Type, f.Payload)
	return v
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if ok() {
			return poll.Success()
		}
		return poll.Continue("waiting for %s", what)
	}, poll.WithTimeout(5*time.Second), poll.WithDelay(10*time.Millisecond))
}

func find(m *Manager, name string) (*proto.SessionInfo, bool) {
	for _, s := range m.List() {
		if s.Name == name {
			return s, true
		}
	}
	return nil, false
}

func TestServeStartsANewSessionUnderTheRequestedName(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `echo ready; sleep 30`)

	st := h.started(t)

	assert.Check(t, st.GetCreated(), "STARTED did not report a new session")
	assert.Check(t, cmp.Equal(st.GetSession(), "main"))
	assert.Check(t, cmp.Equal(m.Attached(), 1))
}

func TestServeLeavesTheProcessRunningWhenTheViewerDetaches(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	st := h.started(t)
	h.until(t, "ready")

	h.detach(t)

	info, ok := find(m, "main")
	assert.Assert(t, ok, "the session is gone")
	assert.Check(t, cmp.Equal(info.State, proto.SessionRunning))
	assert.Check(t, !info.Attached, "the session still counts a viewer")
	assert.Check(t, syscall.Kill(int(st.Pid), 0), "the process is gone")
	assert.Check(t, cmp.Equal(m.Attached(), 0))
}

func TestServeReattachesToTheRunningProcessWithItsReplay(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `trap 'echo got-hup' HUP; echo ready; while read l; do echo "said $l"; done`)
	first := h.started(t)
	h.until(t, "ready")
	h.detach(t)

	again := attach(t, m, "main")
	st := again.started(t)
	again.until(t, "ready")
	again.send(t, proto.TypeStdin, []byte("hello\n"))
	again.until(t, "said hello")

	assert.Check(t, !st.GetCreated(), "the attach made a new session")
	assert.Check(t, cmp.Equal(st.Pid, first.Pid))
	assert.Check(t, !strings.Contains(again.out.String(), "got-hup"), "the detach sent SIGHUP")
}

func TestServeSendsAResizeOnReattachAtTheSameSize(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `trap 'echo winch-$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	same := attach(t, m, "main")
	same.started(t)

	same.until(t, "winch-24 80")
}

func TestServeResizesTheSessionToANewViewersSize(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `trap 'echo winch-$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)

	wide := connect(t, m, &proto.Request{Op: proto.OpSessionAttach, Session: new("main"), Cols: new(uint32(120)), Rows: new(uint32(40))})
	wide.started(t)
	wide.until(t, "winch-40 120")

	info, ok := find(m, "main")
	assert.Assert(t, ok, "the session is gone")
	assert.Check(t, cmp.Equal(info.Cols, uint32(120)))
	assert.Check(t, cmp.Equal(info.Rows, uint32(40)))
}

func TestServeHandsTheSessionToANewViewerAndDetachesTheOldOne(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	first := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	first.started(t)
	first.until(t, "ready")

	second := attach(t, m, "main")
	second.started(t)
	f := first.last(t)
	first.waitServed(t)
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")

	assert.Equal(t, f.Type, proto.TypeDetached, "first viewer got %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Detached](t, f).Reason, proto.DetachTakenOver))
}

func TestServeHandsTheSessionOnFromAHalfOpenViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	m.lastWriteTimeout = 100 * time.Millisecond
	guest, conn := net.Pipe()
	stuck := &host{conn: conn}
	stuck.served = runServe(t, m, &proto.Request{Op: proto.OpExec, Session: new("main"), Tty: new(true), Argv: []string{"sh", "-c", "echo ready; while read l; do echo \"said $l\"; done"}}, guest, conn)
	waitFor(t, "the session", func() bool { _, ok := find(m, "main"); return ok })

	second := attach(t, m, "main")
	second.started(t)
	second.until(t, "ready")
	second.send(t, proto.TypeStdin, []byte("hi\n"))
	second.until(t, "said hi")

	stuck.waitServed(t)
}

func TestServeRecordsTheExitOfADetachedSession(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))

	h.detach(t)

	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })
	info, _ := find(m, "job")
	assert.Assert(t, info.Exit != nil, "no exit recorded")
	assert.Check(t, cmp.Equal(info.Exit.Code, int32(3)))
}

func TestServeGivesALaterViewerTheReplayAndTheExitOfADetachedSession(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))
	h.detach(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })

	later := attach(t, m, "job")
	later.started(t)
	f := later.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(3)))
	assert.Check(t, cmp.Contains(later.out.String(), "bye"), "the replay lost the last output")
}

func TestServeRemovesAnExitedSessionOnceAViewerHasTheExit(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", `read go; echo bye; exit 3`)
	h.started(t)
	h.send(t, proto.TypeStdin, []byte("go\n"))
	h.detach(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })
	later := attach(t, m, "job")
	later.started(t)
	later.last(t)

	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
	code := attach(t, m, "job").errorCode(t)

	assert.Check(t, cmp.Equal(code, proto.ErrNoSession))
}

func TestServeSendsTheExitToTheAttachedViewerAndRemovesTheSession(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", `echo bye; exit 4`)
	h.started(t)

	f := h.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(4)))
	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
}

func TestKillHangsUpTheSessionsProcess(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `echo ready; sleep 30`)
	h.started(t)
	h.until(t, "ready")

	err := m.Kill("main")

	assert.NilError(t, err)
	f := h.last(t)
	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Signal, int32(syscall.SIGHUP)))
}

func TestKillRefusesASessionThatIsAlreadyKilled(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `echo ready; sleep 30`)
	h.started(t)
	h.until(t, "ready")
	assert.NilError(t, m.Kill("main"))

	err := m.Kill("main")

	var pe *proto.Error
	assert.Assert(t, errors.As(err, &pe), "second kill: %v, want a protocol error", err)
	assert.Check(t, cmp.Equal(pe.Code, proto.ErrNoSession))
}

func TestNewManagerTakesTheKillGraceTapWaitAndLastWriteTimeout(t *testing.T) {
	m := NewManager(launch.New(&proc.Direct{Reaper: testReaper}, imagecfg.NewLive(imagecfg.Config{}), nil), "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")

	assert.Check(t, cmp.Equal(m.killGrace, 2*time.Second))
	assert.Check(t, cmp.Equal(m.tapWait, 5*time.Second))
	assert.Check(t, cmp.Equal(m.lastWriteTimeout, 5*time.Second))
}

func TestKillEscalatesToSIGKILLForAProcessThatIgnoresSIGHUP(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	m.killGrace = 200 * time.Millisecond
	h := start(t, m, "main", `trap "" HUP; echo ready; while :; do sleep 0.05; done`)
	h.started(t)
	h.until(t, "ready")

	assert.NilError(t, m.Kill("main"))

	f := h.last(t)
	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Signal, int32(syscall.SIGKILL)))
}

func TestServeRefusesABadRequestAndKeepsNoSession(t *testing.T) {
	for _, tc := range []struct {
		name string
		req  *proto.Request
		code string
	}{
		{name: "no tty", req: &proto.Request{Op: proto.OpExec, Session: new("main"), Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "bad name", req: &proto.Request{Op: proto.OpExec, Session: new("Main"), Tty: new(true), Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "long name", req: &proto.Request{Op: proto.OpExec, Session: new(strings.Repeat("a", 33)), Tty: new(true), Argv: []string{"true"}}, code: proto.ErrBadRequest},
		{name: "no such program", req: &proto.Request{Op: proto.OpExec, Session: new("main"), Tty: new(true), Argv: []string{"no-such-program"}}, code: proto.ErrExecFailed},
		{name: "attach to nothing", req: &proto.Request{Op: proto.OpSessionAttach, Session: new("none")}, code: proto.ErrNoSession},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")

			code := connect(t, m, tc.req).errorCode(t)

			assert.Check(t, cmp.Equal(code, tc.code))
			assert.Check(t, cmp.Len(m.List(), 0))
		})
	}
}

func fillSessions(t *testing.T, m *Manager, from int) {
	t.Helper()
	for i := from; i < MaxSessions; i++ {
		h := start(t, m, fmt.Sprintf("s%d", i), "sleep 30")
		h.started(t)
		h.detach(t)
	}
}

func exitAfterDetach(t *testing.T, m *Manager, name string) {
	t.Helper()
	release := filepath.Join(t.TempDir(), "release")
	h := start(t, m, name, "while [ ! -e "+release+" ]; do sleep 0.01; done; exit 0")
	h.started(t)
	h.detach(t)
	assert.NilError(t, os.WriteFile(release, nil, 0o600))
	waitFor(t, name+" to exit", func() bool { info, _ := find(m, name); return info.State == proto.SessionExited })
}

func TestServeRefusesANewSessionPastTheCap(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	exitAfterDetach(t, m, "s0")
	fillSessions(t, m, 1)

	code := start(t, m, "extra", "sleep 30").errorCode(t)

	assert.Check(t, cmp.Equal(code, proto.ErrSessionCap))
}

func TestServeReplacesAnExitedSessionOfTheSameName(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	exitAfterDetach(t, m, "s0")
	fillSessions(t, m, 1)

	h := start(t, m, "s0", "echo fresh; sleep 30")
	st := h.started(t)
	h.until(t, "fresh")

	assert.Check(t, st.GetCreated(), "the exited session was attached, not replaced")
}

func TestServeAttachesAnExecToARunningSessionOfTheSameName(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	first := start(t, m, "s1", "echo ready; sleep 30")
	first.started(t)
	first.until(t, "ready")
	first.detach(t)

	again := start(t, m, "s1", "echo other")
	st := again.started(t)

	assert.Check(t, !st.GetCreated(), "a running session was replaced")
}

func TestServeRefusesAStartThatDropsSysAdminOverASessionThatHoldsIt(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	first := start(t, m, "s1", "echo ready; sleep 30")
	first.started(t)
	first.until(t, "ready")
	first.detach(t)

	again := connect(t, m, &proto.Request{Op: proto.OpExec, Session: new("s1"), Tty: new(true),
		Argv: []string{"sh", "-c", "echo other"}, Cols: new(uint32(80)), Rows: new(uint32(24)), DropSysAdmin: new(true)})

	assert.Equal(t, again.errorCode(t), proto.ErrBadRequest)
}

func TestServeDropsAViewerThatStopsReading(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	guest, conn := net.Pipe()
	runServe(t, m, &proto.Request{Op: proto.OpExec, Session: new("main"), Tty: new(true), Argv: []string{"sh", "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"}}, guest, conn)
	waitFor(t, "the viewer to be dropped", func() bool { info, ok := find(m, "main"); return ok && !info.Attached })

	r := proto.NewReader(conn)
	var detached proto.Frame
	for detached.Type != proto.TypeDetached {
		f, err := r.Next()
		assert.NilError(t, err, "the connection ended without DETACHED")
		detached = f
	}

	assert.Check(t, cmp.Equal(decode[proto.Detached](t, detached).Reason, proto.DetachSlow))
}

func TestServeKeepsTheSessionRunningAfterItDropsASlowViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	guest, conn := net.Pipe()
	runServe(t, m, &proto.Request{Op: proto.OpExec, Session: new("main"), Tty: new(true), Argv: []string{"sh", "-c", "while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done"}}, guest, conn)
	waitFor(t, "the viewer to be dropped", func() bool { info, ok := find(m, "main"); return ok && !info.Attached })

	fresh := attach(t, m, "main")
	fresh.started(t)
	var types, want []proto.Type
	for range 50 {
		types = append(types, fresh.next(t).Type)
		want = append(want, proto.TypeStdout)
	}

	assert.Check(t, cmp.DeepEqual(types, want))
}

type failingConn struct {
	net.Conn
	failing atomic.Bool
}

func (c *failingConn) Write(b []byte) (int, error) {
	if c.failing.Load() {
		return 0, errors.New("broken")
	}
	return c.Conn.Write(b)
}

func TestServeEndsOnlyTheViewerWhoseWriteFails(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "main", `echo ready; while read l; do echo "said $l"; done`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)
	guest, conn := net.Pipe()
	fc := &failingConn{Conn: guest}
	broken := serve(t, m, &proto.Request{Op: proto.OpSessionAttach, Session: new("main")}, fc, conn)
	broken.started(t)
	// the pipe is synchronous: once the host read the replay, it is written
	broken.until(t, "ready")
	fc.failing.Store(true)

	broken.send(t, proto.TypeStdin, []byte("a\nb\nc\nd\n"))
	broken.waitServed(t)

	fresh := attach(t, m, "main")
	fresh.started(t)
	fresh.send(t, proto.TypeStdin, []byte("e\n"))
	fresh.until(t, "said e")
}

// With no echo, the EXIT is the first frame after the replay, so the one
// write that fails is the EXIT's.
func TestServeKeepsAnExitTheViewerCouldNotBeSentForTheNextViewer(t *testing.T) {
	m := newTestManager(t, "4f3c0f86-8f8b-4c45-a3b4-8e1c1e9b0d11")
	h := start(t, m, "job", `stty -echo; echo ready; read go; exit 5`)
	h.started(t)
	h.until(t, "ready")
	h.detach(t)
	guest, conn := net.Pipe()
	fc := &failingConn{Conn: guest}
	broken := serve(t, m, &proto.Request{Op: proto.OpSessionAttach, Session: new("job")}, fc, conn)
	broken.started(t)
	// the pipe is synchronous: once the host read the replay, it is written
	broken.until(t, "ready")
	fc.failing.Store(true)
	broken.send(t, proto.TypeStdin, []byte("go\n"))
	broken.waitServed(t)
	waitFor(t, "the exit", func() bool { info, _ := find(m, "job"); return info.State == proto.SessionExited })

	later := attach(t, m, "job")
	later.started(t)
	f := later.last(t)

	assert.Equal(t, f.Type, proto.TypeExit, "frame %q", f.Payload)
	assert.Check(t, cmp.Equal(decode[proto.Exit](t, f).Code, int32(5)))
	waitFor(t, "the session to go", func() bool { _, ok := find(m, "job"); return !ok })
}
