package server

import (
	"errors"
	"log"
	"net"
	"sync"
	"time"

	"golang.org/x/sys/unix"
	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/dial"
	"github.com/zgeoff/impz/agent/internal/feature/exec"
	"github.com/zgeoff/impz/agent/internal/feature/files"
	"github.com/zgeoff/impz/agent/internal/feature/listen"
	"github.com/zgeoff/impz/agent/internal/feature/services"
	"github.com/zgeoff/impz/agent/internal/feature/session"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const Port = 1024

const requestTimeout = 10 * time.Second

type Server struct {
	Exec          *exec.Manager
	Outer         *exec.Manager
	Sessions      *session.Manager
	Services      *services.Supervisor
	Listen        *listen.Manager
	Dial          *dial.Dialer
	Files         *files.Store
	Shutdown      func()
	IdentityReset string
	BootID        string
	BootSteps     []*proto.BootStep
	Inner         func() *proto.InnerStatus

	freezeMu    sync.Mutex
	thawTimer   *time.Timer
	freezeGen   uint64
	frozen      bool
	poweringOff bool

	rootIoctl     func(req uint) error
	afterFunc     func(d time.Duration, fn func()) *time.Timer
	waitAndGrow   func(mountpoint string, target int64, timeout time.Duration) error
	autoThawFired func()
}

// A snapshot restore resets the vsock transport. The listen socket should
// survive it, but a failed Accept re-listens rather than return, because a
// return reboots the guest.
const (
	minRelistenDelay = 10 * time.Millisecond
	maxRelistenDelay = time.Second
)

func (s *Server) Serve(listen func() (net.Listener, error)) error {
	l, err := listen()
	if err != nil {
		return err
	}
	delay := minRelistenDelay
	for {
		c, err := l.Accept()
		if err == nil {
			delay = minRelistenDelay
			go s.handle(c)
			continue
		}
		var ne net.Error
		if errors.As(err, &ne) && ne.Timeout() {
			continue
		}
		log.Printf("accept: %v; listening again", err)
		l.Close()
		for {
			time.Sleep(delay)
			delay = min(delay*2, maxRelistenDelay)
			if l, err = listen(); err == nil {
				break
			}
			log.Printf("listen: %v", err)
		}
	}
}

func (s *Server) handle(c net.Conn) {
	defer c.Close()
	defer safe.Recover("request", nil)
	r, w := proto.NewReader(c), proto.NewWriter(c)

	_ = c.SetReadDeadline(time.Now().Add(requestTimeout))
	f, err := r.Next()
	_ = c.SetReadDeadline(time.Time{})
	if err != nil {
		return
	}
	if f.Type != proto.TypeRequest {
		proto.ReplyError(w, &proto.Error{Code: proto.ErrBadRequest, Message: "first frame must be REQUEST, got " + f.Type.String()})
		return
	}
	req := &proto.Request{}
	if err := proto.Unmarshal(f.Payload, req); err != nil {
		proto.ReplyError(w, &proto.Error{Code: proto.ErrBadRequest, Message: err.Error()})
		return
	}

	if req.Op == proto.OpSessionAttach || req.Op == proto.OpSessionTap || (req.Op == proto.OpExec && req.GetSession() != "") {
		if err := s.Sessions.Serve(req, c, r, w); err != nil {
			log.Printf("session %s: %v", req.GetSession(), err)
		}
		return
	}
	if req.Op == proto.OpExec {
		if err := s.Exec.Serve(req, r, w); err != nil {
			log.Printf("exec: %v", err)
		}
		return
	}
	if req.Op == proto.OpExecOuter {
		if err := s.serveOuter(req, r, w); err != nil {
			log.Printf("exec.outer: %v", err)
		}
		return
	}
	if req.Op == proto.OpDial {
		if err := s.Dial.Serve(req, r, w); err != nil {
			log.Printf("dial %s %s: %v", req.GetNetwork(), req.GetAddress(), err)
		}
		return
	}
	if req.Op == proto.OpAgentListen {
		if err := s.Listen.ServeAgent(r, w); err != nil {
			log.Printf("agent.listen: %v", err)
		}
		return
	}
	if req.Op == proto.OpListen {
		if err := s.Listen.Serve(req, r, w); err != nil {
			log.Printf("listen %s %s: %v", req.GetNetwork(), req.GetAddress(), err)
		}
		return
	}
	if req.Op == proto.OpAgentAccept {
		if err := s.Listen.Accept(req, r, w); err != nil {
			log.Printf("agent.accept: %v", err)
		}
		return
	}
	if req.Op == proto.OpServicesLogs {
		s.serveLogs(req, r, w)
		return
	}
	resp, err := s.safeUnary(req)
	if err != nil {
		proto.ReplyError(w, err)
		return
	}
	w.WriteMessage(proto.TypeResponse, resp)
	if req.Op == proto.OpShutdown {
		c.Close()
		s.Shutdown()
	}
}

func (s *Server) safeUnary(req *proto.Request) (resp protoreflect.ProtoMessage, err error) {
	defer safe.Recover("request "+req.Op, func() {
		resp, err = nil, &proto.Error{Code: proto.ErrInternal, Message: "agent panic in " + req.Op}
	})
	return s.unary(req)
}

func (s *Server) unary(req *proto.Request) (protoreflect.ProtoMessage, error) {
	switch req.Op {
	case proto.OpPing:
		ping := BuildPing(unix.ClockGettime)
		if s.IdentityReset != "" {
			ping.IdentityReset = new(s.IdentityReset)
		}
		if s.BootID != "" {
			ping.BootId = new(s.BootID)
		}
		ping.BootSteps = s.BootSteps
		if s.Inner != nil {
			ping.Inner = s.Inner()
		}
		return ping, nil
	case proto.OpActivity:
		return s.activity()
	case proto.OpFreeze:
		return &proto.OK{Ok: true}, s.freeze(time.Duration(req.GetTimeoutMs()) * time.Millisecond)
	case proto.OpThaw:
		return &proto.OK{Ok: true}, s.thaw()
	case proto.OpResumed:
		if req.GetUnixMs() <= 0 {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "unix_ms is required"}
		}
		ts := unix.NsecToTimespec(int64(req.GetUnixMs()) * int64(time.Millisecond))
		return &proto.OK{Ok: true}, unix.ClockSettime(unix.CLOCK_REALTIME, &ts)
	case proto.OpGrow:
		if req.GetDiskBytes() <= 0 {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "disk_bytes is required"}
		}
		return &proto.OK{Ok: true}, s.grow(int64(req.GetDiskBytes()))
	case proto.OpServicesList:
		return &proto.ServicesList{Services: s.Services.List(), ImageUser: s.Services.ImageUser()}, nil
	case proto.OpServicesAdd:
		if req.Def == nil {
			return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "def is required"}
		}
		return &proto.OK{Ok: true}, s.Services.Add(req.Def, req.GetReplace())
	case proto.OpServicesRemove:
		return &proto.OK{Ok: true}, s.Services.Remove(req.GetService())
	case proto.OpServicesRestart:
		return &proto.OK{Ok: true}, s.Services.Restart(req.GetService())
	case proto.OpSessionKill:
		return &proto.OK{Ok: true}, s.Sessions.Kill(req.GetSession())
	case proto.OpFilesWrite:
		return &proto.OK{Ok: true}, s.Files.Write(req.GetPath(), req.GetData())
	case proto.OpFilesRemove:
		removed, err := s.Files.Remove(req.GetPath())
		return &proto.FilesRemoved{Removed: removed}, err
	case proto.OpShutdown:
		return &proto.OK{Ok: true}, nil
	default:
		return nil, &proto.Error{Code: proto.ErrUnknownOp, Message: "unknown op " + req.Op}
	}
}

// The agent's own world has no accounts, and a session would outlive the
// caller.
func (s *Server) serveOuter(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	if req.GetSession() != "" {
		return proto.ReplyError(w, &proto.Error{Code: proto.ErrBadRequest, Message: "an outer exec takes no session"})
	}
	if req.GetUser() != "" && req.GetUser() != "root" && req.GetUser() != "0" {
		return proto.ReplyError(w, &proto.Error{Code: proto.ErrBadRequest, Message: "an outer exec runs as root"})
	}
	return s.Outer.Serve(req, r, w)
}

func (s *Server) serveLogs(req *proto.Request, r *proto.Reader, w *proto.Writer) {
	// the host closes the connection to stop a follow
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			if _, err := r.Next(); err != nil {
				return
			}
		}
	}()
	logReq := services.LogRequest{Lines: int(req.GetLines()), Follow: req.GetFollow(), Cursor: req.Cursor}
	err := s.Services.Logs(req.GetService(), logReq, w, done)
	var pe *proto.Error
	if errors.As(err, &pe) {
		proto.ReplyError(w, pe)
	} else if err != nil {
		log.Printf("services.logs %s: %v", req.GetService(), err)
	}
}

// No uptime when the clock read fails: a 0 would make impd wait out a guest
// that is not young.
func BuildPing(clockGettime func(int32, *unix.Timespec) error) *proto.Ping {
	ping := &proto.Ping{Ok: true, Version: proto.Version}
	var ts unix.Timespec
	if clockGettime(unix.CLOCK_BOOTTIME, &ts) == nil {
		ping.UptimeMs = new(float64(ts.Nano() / int64(time.Millisecond)))
	}
	return ping
}
