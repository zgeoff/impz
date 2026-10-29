package main

import (
	"encoding/json"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/poll"
)

// The test binary plays Firecracker in a child process, so a kill that the
// handler sends reaches the child and not the test.
const (
	peerSocketEnv     = "UFFD_HANDLER_TEST_PEER_SOCKET"
	peerAdvertisedEnv = "UFFD_HANDLER_TEST_PEER_ADVERTISED"
	peerReadsEnv      = "UFFD_HANDLER_TEST_PEER_READS"
)

// From linux/userfaultfd.h: what Firecracker does to make and register the
// uffd it sends. A user-mode-only uffd needs no privilege.
const (
	uffdUserModeOnly       = 1
	uffdAPI                = 0xaa
	uffdFeatureEventRemove = 1 << 3
	uffdioAPI              = 0xc018aa3f
	uffdioRegister         = 0xc020aa00
	uffdioRegisterMissing  = 1
	testPage               = 4096
	testPages              = 3
)

type uffdioAPIArg struct {
	api      uint64
	features uint64
	ioctls   uint64
}

type uffdioRegisterArg struct {
	start  uint64
	len    uint64
	mode   uint64
	ioctls uint64
}

func TestMain(m *testing.M) {
	if socket := os.Getenv(peerSocketEnv); socket != "" {
		if err := runPeer(socket); err != nil {
			os.Stdout.WriteString("error " + err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runPeer registers three pages with a new uffd, sends them to the handler as
// Firecracker does, reads the pages that the test names, prints each one's
// first byte, and waits for its stdin to close.
func runPeer(socket string) error {
	advertised, err := strconv.ParseUint(os.Getenv(peerAdvertisedEnv), 10, 64)
	if err != nil {
		return err
	}
	mem, fd, err := registerMemory()
	if err != nil {
		return err
	}
	base := uint64(uintptr(unsafe.Pointer(&mem[0])))
	if err := sendRegions(socket, base, fd, advertised); err != nil {
		return err
	}
	for _, field := range strings.Split(os.Getenv(peerReadsEnv), ",") {
		page, err := strconv.Atoi(field)
		if err != nil {
			return err
		}
		os.Stdout.Write([]byte{mem[page*testPage]})
	}
	_, _ = os.Stdin.Read(make([]byte, 1))
	return nil
}

func registerMemory() ([]byte, int, error) {
	mem, err := unix.Mmap(-1, 0, testPages*testPage, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS)
	if err != nil {
		return nil, -1, err
	}
	fd, _, errno := unix.Syscall(unix.SYS_USERFAULTFD, unix.O_CLOEXEC|unix.O_NONBLOCK|uffdUserModeOnly, 0, 0)
	if errno != 0 {
		return nil, -1, errno
	}
	api := uffdioAPIArg{api: uffdAPI, features: uffdFeatureEventRemove}
	if err := ioctl(int(fd), uffdioAPI, unsafe.Pointer(&api)); err != nil {
		return nil, -1, err
	}
	register := uffdioRegisterArg{start: uint64(uintptr(unsafe.Pointer(&mem[0]))), len: testPages * testPage, mode: uffdioRegisterMissing}
	if err := ioctl(int(fd), uffdioRegister, unsafe.Pointer(&register)); err != nil {
		return nil, -1, err
	}
	return mem, int(fd), nil
}

func sendRegions(socket string, base uint64, fd int, advertisedPages uint64) error {
	regions, err := json.Marshal([]guestRegion{{BaseHostVirtAddr: base, Size: advertisedPages * testPage, Offset: 0, PageSize: testPage}})
	if err != nil {
		return err
	}
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return err
	}
	defer conn.Close()
	_, _, err = conn.WriteMsgUnix(regions, unix.UnixRights(fd), nil)
	return err
}

func ioctl(fd int, request uintptr, arg unsafe.Pointer) error {
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), request, uintptr(arg)); errno != 0 {
		return errno
	}
	return nil
}

// writeMemFile writes a three-page memory file: a page of 'a', a hole, and a
// page of 'c'.
func writeMemFile(t *testing.T, dir string) *os.File {
	t.Helper()
	path := filepath.Join(dir, "mem")
	file, err := os.Create(path)
	assert.NilError(t, err)
	_, err = file.WriteAt(bytesOf('a', testPage), 0)
	assert.NilError(t, err)
	_, err = file.WriteAt(bytesOf('c', testPage), 2*testPage)
	assert.NilError(t, err)
	return file
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

type peer struct {
	cmd    *exec.Cmd
	stdin  *os.File
	stdout *os.File
}

// startPeer starts the child that plays Firecracker once the handler's socket
// is in place.
func startPeer(t *testing.T, socket string, advertisedPages int, reads string) peer {
	t.Helper()
	self, err := os.Executable()
	assert.NilError(t, err)
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if _, err := os.Stat(socket); err == nil {
			return poll.Success()
		}
		return poll.Continue("the handler's socket is not in place")
	})
	stdinRead, stdinWrite, err := os.Pipe()
	assert.NilError(t, err)
	stdoutRead, stdoutWrite, err := os.Pipe()
	assert.NilError(t, err)
	cmd := exec.Command(self)
	cmd.Env = append(os.Environ(),
		peerSocketEnv+"="+socket,
		peerAdvertisedEnv+"="+strconv.Itoa(advertisedPages),
		peerReadsEnv+"="+reads,
	)
	cmd.Stdin = stdinRead
	cmd.Stdout = stdoutWrite
	assert.NilError(t, cmd.Start())
	stdinRead.Close()
	stdoutWrite.Close()
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		stdinWrite.Close()
		stdoutRead.Close()
	})
	return peer{cmd: cmd, stdin: stdinWrite, stdout: stdoutRead}
}

func readPeerBytes(t *testing.T, p peer, n int) []byte {
	t.Helper()
	out := make([]byte, n)
	_, err := p.stdout.Read(out)
	assert.NilError(t, err)
	return out
}

func startRun(t *testing.T, opts options, memFile *os.File) chan error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- run(opts, memFile) }()
	return done
}

func TestRunServesTheMemoryFileUntilItsPeerExits(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	socket := "uffd.sock"
	done := startRun(t, options{socket: socket}, writeMemFile(t, dir))
	p := startPeer(t, socket, testPages, "0,1,2")

	read := readPeerBytes(t, p, testPages)
	p.stdin.Close()
	peerErr := p.cmd.Wait()

	assert.DeepEqual(t, read, []byte{'a', 0, 'c'})
	assert.NilError(t, peerErr)
	assert.NilError(t, <-done)
}

func TestRunKillsItsPeerOnAFaultItCannotServe(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	socket := "uffd.sock"
	done := startRun(t, options{socket: socket}, writeMemFile(t, dir))
	p := startPeer(t, socket, 2, "2")

	peerErr := p.cmd.Wait()

	var exit *exec.ExitError
	assert.Assert(t, errors.As(peerErr, &exit), "the peer exited with %v", peerErr)
	assert.Equal(t, exit.Sys().(syscall.WaitStatus).Signal(), syscall.SIGKILL)
	assert.ErrorContains(t, <-done, "outside every region")
}

func TestRunKillsAPeerWhoseRegionsPassTheMemoryFile(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	socket := "uffd.sock"
	done := startRun(t, options{socket: socket}, writeMemFile(t, dir))
	p := startPeer(t, socket, testPages+1, "0")

	peerErr := p.cmd.Wait()

	var exit *exec.ExitError
	assert.Assert(t, errors.As(peerErr, &exit), "the peer exited with %v", peerErr)
	assert.Equal(t, exit.Sys().(syscall.WaitStatus).Signal(), syscall.SIGKILL)
	assert.ErrorContains(t, <-done, "past the memory file")
}

func TestRunRefusesAnEmptyMemoryFile(t *testing.T) {
	dir := t.TempDir()
	file, err := os.Create(filepath.Join(dir, "mem"))
	assert.NilError(t, err)

	err = run(options{socket: filepath.Join(dir, "uffd.sock")}, file)

	assert.ErrorContains(t, err, "not a regular file with data")
}

func TestListenLeavesTheSocketReadableOnlyByItsOwner(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	t.Chdir(t.TempDir())
	socket := "uffd.sock"

	listener, err := listen(socket, nil)
	assert.NilError(t, err)
	t.Cleanup(func() { listener.Close() })
	info, statErr := os.Lstat(socket)

	assert.NilError(t, statErr)
	assert.Equal(t, info.Mode().Type(), os.ModeSocket)
	assert.Equal(t, info.Mode().Perm(), os.FileMode(0o600))
}

func TestParseOptionsReadsTheSocketAndTheJailsUser(t *testing.T) {
	opts, err := parseOptions([]string{"--socket", "/run/uffd.sock", "--uid", "20001", "--gid", "20002"})

	assert.NilError(t, err)
	assert.Equal(t, opts.socket, "/run/uffd.sock")
	assert.Equal(t, *opts.owner, owner{uid: 20001, gid: 20002})
}

func TestParseOptionsRefusesBadArguments(t *testing.T) {
	for _, tc := range []struct {
		name string
		args []string
		want string
	}{
		{"no socket", []string{"--uid", "20001", "--gid", "20001"}, "--socket is required"},
		{"a uid without a gid", []string{"--socket", "s", "--uid", "20001"}, "go together"},
		{"root as the user", []string{"--socket", "s", "--uid", "0", "--gid", "0"}, "positive numbers"},
		{"a name as the uid", []string{"--socket", "s", "--uid", "imp", "--gid", "20001"}, "positive numbers"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := parseOptions(tc.args)

			assert.ErrorContains(t, err, tc.want)
		})
	}
}
