package dial

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const ListenCommand = "listen-as-user"

const listenBacklog = 64

// Dir, Dev and Ino let the agent remove its own socket and never a file
// another process put at the name later.
type Bound struct {
	Listener net.Listener
	Port     int
	Dir      int
	Name     string
	Dev, Ino uint64
}

func (b *Bound) Close() {
	b.Listener.Close()
	if b.Dir < 0 {
		return
	}
	// Through the held directory, so a directory swapped for a symlink since
	// the bind changes nothing.
	var st unix.Stat_t
	err := unix.Fstatat(b.Dir, b.Name, &st, unix.AT_SYMLINK_NOFOLLOW)
	if err == nil && st.Mode&unix.S_IFMT == unix.S_IFSOCK && uint64(st.Dev) == b.Dev && st.Ino == b.Ino {
		_ = unix.Unlinkat(b.Dir, b.Name, 0)
	}
	unix.Close(b.Dir)
}

func (d *Dialer) Listen(network, address string) (*Bound, error) {
	if err := checkListenAddress(network, address); err != nil {
		return nil, err
	}
	// as root too: the path resolves in the user's world
	fds, err := d.runHelper([]string{ListenCommand, network, address}, 2, proto.ErrListenFailed)
	if err != nil {
		return nil, err
	}
	return wrapBound(fds, network, address)
}

func checkListenAddress(network, address string) error {
	switch network {
	case "unix":
		if !filepath.IsAbs(address) {
			return &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path must be absolute (abstract sockets are not supported): " + address}
		}
		if filepath.Clean(address) == "/" {
			return &proto.Error{Code: proto.ErrBadRequest, Message: "a unix socket path needs a name"}
		}
		return nil
	case "tcp":
		_, err := parseLoopbackPort(address)
		return err
	default:
		return &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("network must be tcp or unix, got %q", network)}
	}
}

func parseLoopbackPort(address string) (int, error) {
	host, portText, err := net.SplitHostPort(address)
	port, perr := strconv.Atoi(portText)
	if err != nil || host != "127.0.0.1" || perr != nil || port < 0 || port > 65535 {
		return 0, &proto.Error{Code: proto.ErrBadRequest, Message: "a tcp listen address must be 127.0.0.1:<port>, got " + address}
	}
	return port, nil
}

func wrapBound(fds []int, network, address string) (*Bound, error) {
	failed := func(message string) (*Bound, error) {
		sysutil.CloseFds(fds)
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: message}
	}
	if accepting, err := unix.GetsockoptInt(fds[0], unix.SOL_SOCKET, unix.SO_ACCEPTCONN); err != nil || accepting != 1 {
		return failed("the helper answered with a socket that does not listen")
	}
	b := &Bound{Dir: -1}
	if network == "unix" {
		if len(fds) != 2 {
			return failed("the helper answered without the socket's directory")
		}
		var dir unix.Stat_t
		if err := unix.Fstat(fds[1], &dir); err != nil || dir.Mode&unix.S_IFMT != unix.S_IFDIR {
			return failed("the helper answered with something other than a directory")
		}
		b.Dir, b.Name = fds[1], filepath.Base(filepath.Clean(address))
		var st unix.Stat_t
		if err := unix.Fstatat(b.Dir, b.Name, &st, unix.AT_SYMLINK_NOFOLLOW); err != nil || st.Mode&unix.S_IFMT != unix.S_IFSOCK {
			return failed(address + " is not the socket the helper bound")
		}
		b.Dev, b.Ino = uint64(st.Dev), st.Ino
	} else if len(fds) != 1 {
		return failed("the helper answered with more than the socket")
	}

	f := os.NewFile(uintptr(fds[0]), network+":"+address)
	ln, err := net.FileListener(f)
	f.Close()
	if err != nil {
		if b.Dir >= 0 {
			unix.Close(b.Dir)
		}
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: "wrap the listener: " + err.Error()}
	}
	b.Listener = ln
	if addr, ok := ln.Addr().(*net.TCPAddr); ok {
		b.Port = addr.Port
	}
	return b, nil
}

func bindSocket(network, address, ownDir string) ([]int, error) {
	if network == "tcp" {
		fd, err := bindTCP(address)
		if err != nil {
			return nil, err
		}
		return []int{fd}, nil
	}
	return bindUnix(address, ownDir)
}

func bindTCP(address string) (int, error) {
	port, err := parseLoopbackPort(address)
	if err != nil {
		return -1, err
	}
	sock, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return -1, &proto.Error{Code: proto.ErrListenFailed, Message: "socket: " + err.Error()}
	}
	_ = unix.SetsockoptInt(sock, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1)
	err = unix.Bind(sock, &unix.SockaddrInet4{Port: port, Addr: [4]byte{127, 0, 0, 1}})
	if err == nil {
		err = unix.Listen(sock, listenBacklog)
	}
	if err != nil {
		unix.Close(sock)
		message := fmt.Sprintf("listen on %s: %v", address, err)
		if errors.Is(err, unix.EACCES) {
			message = fmt.Sprintf("port %d needs root in the imp; pick a port above 1023", port)
		}
		return -1, &proto.Error{Code: proto.ErrListenFailed, Message: message}
	}
	return sock, nil
}

func bindUnix(address, ownDir string) ([]int, error) {
	clean := filepath.Clean(address)
	dirPath, name := filepath.Dir(clean), filepath.Base(clean)
	dir, err := unix.Open(dirPath, unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if errors.Is(err, unix.ENOENT) {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("the directory %s does not exist in the imp", dirPath)}
	}
	if err != nil {
		return nil, &proto.Error{Code: proto.ErrListenFailed, Message: fmt.Sprintf("open %s: %v", dirPath, err)}
	}
	sock := -1
	fail := func(code, message string) ([]int, error) {
		unix.Close(dir)
		if sock >= 0 {
			unix.Close(sock)
		}
		return nil, &proto.Error{Code: code, Message: message}
	}

	procDir := fmt.Sprintf("/proc/self/fd/%d", dir)
	real, err := os.Readlink(procDir)
	if err != nil {
		return fail(proto.ErrListenFailed, err.Error())
	}
	if real == ownDir || strings.HasPrefix(real, ownDir+"/") {
		return fail(proto.ErrBadRequest, address+" leads to the agent's own sockets")
	}

	// A socket that a forward ended by a forced sleep left at the name is
	// replaced, as OpenSSH's StreamLocalBindUnlink does.
	var st unix.Stat_t
	err = unix.Fstatat(dir, name, &st, unix.AT_SYMLINK_NOFOLLOW)
	switch {
	case err == nil && st.Mode&unix.S_IFMT == unix.S_IFSOCK:
		if err := unix.Unlinkat(dir, name, 0); err != nil && !errors.Is(err, unix.ENOENT) {
			return fail(proto.ErrListenFailed, fmt.Sprintf("remove the old socket %s: %v", address, err))
		}
	case err == nil:
		return fail(proto.ErrListenFailed, address+" exists and is not a socket")
	case !errors.Is(err, unix.ENOENT):
		return fail(proto.ErrListenFailed, fmt.Sprintf("stat %s: %v", address, err))
	}

	if sock, err = unix.Socket(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0); err != nil {
		return fail(proto.ErrListenFailed, "socket: "+err.Error())
	}
	// Through the open directory: the path the check resolved is the one
	// bound. A fresh socket's mode follows the umask; the chmod narrows it.
	bindPath := procDir + "/" + name
	if err := unix.Bind(sock, &unix.SockaddrUnix{Name: bindPath}); err != nil {
		return fail(proto.ErrListenFailed, fmt.Sprintf("bind %s: %v", address, err))
	}
	if err := unix.Fchmodat(dir, name, 0o600, 0); err != nil {
		_ = unix.Unlinkat(dir, name, 0)
		return fail(proto.ErrListenFailed, fmt.Sprintf("chmod %s: %v", address, err))
	}
	if err := unix.Listen(sock, listenBacklog); err != nil {
		_ = unix.Unlinkat(dir, name, 0)
		return fail(proto.ErrListenFailed, fmt.Sprintf("listen on %s: %v", address, err))
	}
	return []int{sock, dir}, nil
}

func RunListenHelper(network, address string) error {
	if err := checkListenAddress(network, address); err != nil {
		return answer(nil, err)
	}
	return answer(bindSocket(network, address, impDir))
}
