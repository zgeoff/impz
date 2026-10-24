package inner

import (
	"encoding/json"
	"errors"
	"fmt"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
)

const Command = "inner"

const sockFd = 3

const maxMessage = 4 << 20

const (
	opReady  = "ready"
	opSpawn  = "spawn"
	opSignal = "signal"
	opReply  = "reply"
	opExit   = "exit"
)

type message struct {
	ID uint64 `json:"id,omitempty"`
	Op string `json:"op"`

	Spec *wireSpec `json:"spec,omitempty"`

	Pid      int  `json:"pid,omitempty"`
	Sig      int  `json:"sig,omitempty"`
	Group    bool `json:"group,omitempty"`
	InCgroup bool `json:"in_cgroup,omitempty"`

	// an errno travels as a number, so the agent's errors.Is works
	Errno int    `json:"errno,omitempty"`
	Error string `json:"error,omitempty"`

	Code   int `json:"code,omitempty"`
	Signal int `json:"signal,omitempty"`
}

type wireSpec struct {
	Argv      []string  `json:"argv"`
	Env       []string  `json:"env"`
	Dir       string    `json:"dir,omitempty"`
	Workdir   string    `json:"workdir,omitempty"`
	User      string    `json:"user,omitempty"`
	Cred      *wireCred `json:"cred,omitempty"`
	SetHome   bool      `json:"set_home,omitempty"`
	TTY       bool      `json:"tty,omitempty"`
	Helper    bool      `json:"helper,omitempty"`
	Files     int       `json:"files"`
	HasCgroup bool      `json:"has_cgroup,omitempty"`
	// the agent and the inner init are one binary, so neither meets a peer
	// that ignores this
	DropSysAdmin bool `json:"drop_sys_admin,omitempty"`
}

type wireCred struct {
	Uid    uint32   `json:"uid"`
	Gid    uint32   `json:"gid"`
	Groups []uint32 `json:"groups"`
}

func toWire(s proc.Spec) *wireSpec {
	w := &wireSpec{
		Argv: s.Argv, Env: s.Env, Dir: s.Dir, Workdir: s.Workdir, User: s.User,
		SetHome: s.SetHome, TTY: s.TTY, Helper: s.Helper, Files: len(s.Files),
		HasCgroup: s.Cgroup != nil, DropSysAdmin: s.DropSysAdmin,
	}
	if s.Cred != nil {
		w.Cred = &wireCred{Uid: s.Cred.Uid, Gid: s.Cred.Gid, Groups: s.Cred.Groups}
	}
	return w
}

// SOCK_SEQPACKET keeps each message and its fds together.
func send(sock int, m message, fds []int) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > maxMessage {
		return fmt.Errorf("a %s message of %d bytes passes the %d-byte limit", m.Op, len(b), maxMessage)
	}
	var oob []byte
	if len(fds) > 0 {
		oob = unix.UnixRights(fds...)
	}
	for {
		err := unix.Sendmsg(sock, b, oob, nil, 0)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		return err
	}
}

func newBuffer() []byte { return make([]byte, maxMessage) }

func recv(sock int, buf []byte) (message, []int, error) {
	oob := make([]byte, unix.CmsgSpace(64*4))
	for {
		n, oobn, flags, _, err := unix.Recvmsg(sock, buf, oob, unix.MSG_CMSG_CLOEXEC)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return message{}, nil, err
		}
		fds := sysutil.ParseRights(oob[:oobn])
		if n == 0 {
			sysutil.CloseFds(fds)
			return message{}, nil, errClosed
		}
		if flags&(unix.MSG_TRUNC|unix.MSG_CTRUNC) != 0 {
			sysutil.CloseFds(fds)
			return message{}, nil, errors.New("a message was cut short")
		}
		var m message
		if err := json.Unmarshal(buf[:n], &m); err != nil {
			sysutil.CloseFds(fds)
			return message{}, nil, err
		}
		return m, fds, nil
	}
}

var errClosed = errors.New("the inner container's socket closed")

// One SEQPACKET message must fit in the socket's buffer whole.
func newSocketpair() ([2]int, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return pair, err
	}
	for _, fd := range pair {
		// FORCE passes rmem_max and wmem_max; the agent is root
		_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_SNDBUFFORCE, 2*maxMessage)
		_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUFFORCE, 2*maxMessage)
	}
	return pair, nil
}

func errnoOf(err error) int {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return int(errno)
	}
	return 0
}

func replyErr(m message) error {
	switch {
	case m.Error == "" && m.Errno == 0:
		return nil
	case m.Errno != 0 && m.Error == "":
		return syscall.Errno(m.Errno)
	case m.Errno != 0:
		return fmt.Errorf("%s: %w", m.Error, syscall.Errno(m.Errno))
	default:
		return errors.New(m.Error)
	}
}
