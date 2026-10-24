package dial

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// A unix dial runs in a helper process, not on a thread with the user's
// credentials: Go moves goroutines between threads, and the server's
// SO_PEERCRED must see the user's uid and pid, not PID 1.
const HelperCommand = "dial-unix"

// The helper's connect never blocks, so the margin over the dial timeout
// covers the fork and exec.
const helperTimeout = dialTimeout + 2*time.Second

const (
	answerOK         = 'k'
	answerBadRequest = 'b'
	answerFailed     = 'd'
)

type Dialer struct {
	runner proc.Runner
	image  *imagecfg.Live

	// cred, when set, replaces user: tests set credentials without
	// /etc/passwd
	cred          *syscall.Credential
	helperTimeout time.Duration
}

func NewDialer(runner proc.Runner, image *imagecfg.Live) *Dialer {
	return &Dialer{runner: runner, image: image, helperTimeout: helperTimeout}
}

func (d *Dialer) openUnix(address string) (net.Conn, error) {
	if !filepath.IsAbs(address) {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path must be absolute (abstract sockets are not supported): " + address}
	}
	// Root dials through the helper too, so the path resolves in the user's
	// world and never in the agent's.
	fds, err := d.runHelper([]string{HelperCommand, address}, 1, proto.ErrDialFailed)
	if err != nil {
		return nil, err
	}
	return fileConn(fds[0], address)
}

func (d *Dialer) runHelper(args []string, max int, failCode string) ([]int, error) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "socketpair: " + err.Error()}
	}
	parent, child := pair[0], os.NewFile(uintptr(pair[1]), "helper")
	defer unix.Close(parent)
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		child.Close()
		return nil, &proto.Error{Code: failCode, Message: "open /dev/null: " + err.Error()}
	}
	defer devNull.Close()

	// /dev/null as fds 1 and 2 puts the helper's own fds above 2, so a
	// runtime crash message never goes into the target socket.
	p, err := d.runner.Start(proc.Spec{
		Argv:   append([]string{"imp-agent"}, args...),
		Env:    []string{},
		Dir:    "/",
		User:   d.image.Get().User,
		Cred:   d.cred,
		Helper: true,
		Files:  []*os.File{child, devNull, devNull},
	})
	child.Close()
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "start the helper: " + err.Error()}
	}

	fds, err := receiveFds(parent, d.helperTimeout, max, failCode)
	if err != nil {
		// A helper that hangs must not outlive its request; the reaper reaps
		// it. Kill reaches only this helper, never a process that reused its
		// pid.
		_ = p.Kill()
		waitHelper(p, d.helperTimeout)
		return nil, err
	}
	// The helper holds its own copy of what it sent until it exits: a
	// listener closed before then would still accept.
	waitHelper(p, d.helperTimeout)
	return fds, nil
}

func waitHelper(p *proc.Process, timeout time.Duration) {
	select {
	case <-p.Done:
		return
	case <-time.After(timeout):
	}
	_ = p.Kill()
	<-p.Done
}

func receiveFds(conn int, timeout time.Duration, max int, failCode string) ([]int, error) {
	if err := waitReadable(conn, timeout, failCode); err != nil {
		return nil, err
	}
	buf := make([]byte, 4096)
	oob := make([]byte, unix.CmsgSpace(4*4))
	// MSG_CMSG_CLOEXEC, so a child forked meanwhile for an exec never
	// inherits the received fds.
	n, oobn, _, _, err := unix.Recvmsg(conn, buf, oob, unix.MSG_CMSG_CLOEXEC)
	if err != nil {
		return nil, &proto.Error{Code: failCode, Message: "read the helper's answer: " + err.Error()}
	}
	fds := sysutil.ParseRights(oob[:oobn])
	var keep []int
	if n >= 1 && buf[0] == answerOK && len(fds) >= 1 {
		keep = fds[:min(max, len(fds))]
		fds = fds[len(keep):]
	}
	sysutil.CloseFds(fds)

	switch {
	case n == 0:
		return nil, &proto.Error{Code: failCode, Message: "the helper exited without an answer"}
	case keep != nil:
		if !isStreamSocket(keep[0]) {
			sysutil.CloseFds(keep)
			return nil, &proto.Error{Code: failCode, Message: "the helper answered with something other than a stream socket"}
		}
		return keep, nil
	case buf[0] == answerBadRequest:
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: string(buf[1:n])}
	case buf[0] == answerFailed:
		return nil, &proto.Error{Code: failCode, Message: string(buf[1:n])}
	default:
		return nil, &proto.Error{Code: failCode, Message: "the helper's answer makes no sense"}
	}
}

func helperFailed(message string) error {
	return &proto.Error{Code: proto.ErrDialFailed, Message: message}
}

// Holds an OS thread for up to the timeout, and the reaper runs one fork at
// a time: both fine at the rate SSH forwards open.
func waitReadable(conn int, timeout time.Duration, failCode string) error {
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return &proto.Error{Code: failCode, Message: fmt.Sprintf("the helper did not answer within %s", timeout)}
		}
		fds := []unix.PollFd{{Fd: int32(conn), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, int(left.Milliseconds())+1)
		// the reaper's SIGCHLD interrupts poll
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return &proto.Error{Code: failCode, Message: "poll the helper: " + err.Error()}
		}
		if n > 0 {
			return nil
		}
	}
}

func isStreamSocket(fd int) bool {
	typ, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
	return err == nil && typ == unix.SOCK_STREAM
}

func fileConn(fd int, address string) (net.Conn, error) {
	f := os.NewFile(uintptr(fd), "unix:"+address)
	// net.FileConn keeps its own copy of the fd.
	defer f.Close()
	c, err := net.FileConn(f)
	if err != nil {
		return nil, helperFailed("wrap the socket: " + err.Error())
	}
	return c, nil
}

// Opens the path with O_PATH and connects through /proc/self/fd, so the path
// checked against ownDir is the one connected to.
func connectUnix(address, ownDir string) (int, error) {
	pathFd, err := unix.Open(address, unix.O_PATH|unix.O_CLOEXEC, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: fmt.Sprintf("open %s: %v", address, err)}
	}
	defer unix.Close(pathFd)
	procPath := fmt.Sprintf("/proc/self/fd/%d", pathFd)

	// Not a boundary: every forwarded ssh-agent socket belongs to the image
	// USER, who may reach it anyway. It keeps a root image's dial off the
	// agent's own sockets.
	real, err := os.Readlink(procPath)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: err.Error()}
	}
	if real == ownDir || strings.HasPrefix(real, ownDir+"/") {
		return -1, &proto.Error{Code: proto.ErrBadRequest, Message: address + " leads to the agent's own sockets"}
	}

	sock, err := unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: "socket: " + err.Error()}
	}
	// a unix connect does not wait: a full backlog fails with EAGAIN at once
	if err := unix.Connect(sock, &unix.SockaddrUnix{Name: procPath}); err != nil {
		unix.Close(sock)
		return -1, &proto.Error{Code: proto.ErrDialFailed, Message: fmt.Sprintf("connect %s: %v", address, err)}
	}
	return sock, nil
}

func RunHelper(address string) error {
	fd, err := connectUnix(address, impDir)
	if err != nil {
		return answer(nil, err)
	}
	return answer([]int{fd}, nil)
}

func answer(fds []int, err error) error {
	if err == nil {
		return unix.Sendmsg(0, []byte{answerOK}, unix.UnixRights(fds...), nil, 0)
	}
	code, text := byte(answerFailed), err.Error()
	var pe *proto.Error
	if errors.As(err, &pe) {
		text = pe.Message
		if pe.Code == proto.ErrBadRequest {
			code = answerBadRequest
		}
	}
	return unix.Sendmsg(0, append([]byte{code}, text...), nil, nil, 0)
}
