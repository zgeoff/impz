package main

import (
	"encoding/binary"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
)

// From linux/userfaultfd.h: what Firecracker does to make and register the
// uffd it sends, which the tests do in Firecracker's place. A user-mode-only
// uffd needs no privilege.
const (
	uffdUserModeOnly       = 1
	uffdAPI                = 0xaa
	uffdFeatureEventRemove = 1 << 3
	uffdioAPI              = 0xc018aa3f
	uffdioRegister         = 0xc020aa00
	uffdioRegisterMissing  = 1
	testPage               = 4096
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

// setupGuestMemory plays Firecracker's side of the handshake: it maps three
// pages, registers them with a new uffd, and sends a region of the first
// advertisedPages pages and the uffd to the handler's socket.
func setupGuestMemory(t *testing.T, socket string, advertisedPages uint64) []byte {
	t.Helper()
	mem, err := unix.Mmap(-1, 0, 3*testPage, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS)
	assert.NilError(t, err)
	t.Cleanup(func() { _ = unix.Munmap(mem) })

	fd, _, errno := unix.Syscall(unix.SYS_USERFAULTFD, unix.O_CLOEXEC|unix.O_NONBLOCK|uffdUserModeOnly, 0, 0)
	if errno == unix.EINVAL || errno == unix.ENOSYS {
		t.Skipf("this kernel has no user-mode userfaultfd: %v", errno)
	}
	assert.Assert(t, errno == 0, "userfaultfd: %v", errno)
	defer unix.Close(int(fd))

	api := uffdioAPIArg{api: uffdAPI, features: uffdFeatureEventRemove}
	assert.NilError(t, ioctl(int(fd), uffdioAPI, unsafe.Pointer(&api)))
	base := uint64(uintptr(unsafe.Pointer(&mem[0])))
	register := uffdioRegisterArg{start: base, len: 3 * testPage, mode: uffdioRegisterMissing}
	assert.NilError(t, ioctl(int(fd), uffdioRegister, unsafe.Pointer(&register)))

	regions, err := json.Marshal([]guestRegion{{BaseHostVirtAddr: base, Size: advertisedPages * testPage, Offset: 0, PageSize: testPage}})
	assert.NilError(t, err)
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: socket, Net: "unix"})
	assert.NilError(t, err)
	defer conn.Close()
	_, _, err = conn.WriteMsgUnix(regions, unix.UnixRights(int(fd)), nil)
	assert.NilError(t, err)
	return mem
}

// writeMemFile writes a three-page memory file: a page of 'a', a hole, and a
// page of 'c'.
func writeMemFile(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "mem")
	file, err := os.Create(path)
	assert.NilError(t, err)
	defer file.Close()
	_, err = file.WriteAt(bytesOf('a', testPage), 0)
	assert.NilError(t, err)
	_, err = file.WriteAt(bytesOf('c', testPage), 2*testPage)
	assert.NilError(t, err)
	return path
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func TestUffdHandlerCopiesTheMemoryFileIntoFaultingPages(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	memFile := writeMemFile(t, dir)
	var phase atomic.Int32
	handler, err := startUffdHandler("uffd.sock", memFile, &phase, nil)
	assert.NilError(t, err)
	mem := setupGuestMemory(t, "uffd.sock", 3)
	assert.NilError(t, <-handler.ready)
	assert.NilError(t, (<-handler.filled).err)

	first, hole := mem[0], mem[testPage]
	phase.Store(phaseClaimed)
	last := mem[3*testPage-1]
	handler.close()
	report, pages := handler.report()

	assert.Equal(t, first, byte('a'))
	assert.Equal(t, hole, byte(0))
	assert.Equal(t, last, byte('c'))
	assert.DeepEqual(t, report.ByPhase, map[string]int{"load": 2, "resumed": 0, "claimed": 1, "agent": 0})
	assert.DeepEqual(t, pages, []int64{0, testPage, 2 * testPage})
	assert.Equal(t, len(report.Errors), 0)
}

func TestUffdHandlerFillsPagesBeforeAnyFault(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	memFile := writeMemFile(t, dir)
	var phase atomic.Int32
	handler, err := startUffdHandler("uffd.sock", memFile, &phase, []int64{0, 2 * testPage})
	assert.NilError(t, err)
	mem := setupGuestMemory(t, "uffd.sock", 3)
	assert.NilError(t, <-handler.ready)
	filled := <-handler.filled

	first, last := mem[0], mem[2*testPage]
	handler.close()
	report, _ := handler.report()

	assert.NilError(t, filled.err)
	assert.Equal(t, filled.pages, 2)
	assert.Equal(t, first, byte('a'))
	assert.Equal(t, last, byte('c'))
	assert.Equal(t, report.ByPhase["load"], 0)
}

func TestUffdHandlerGivesARemovedRangeBackToTheKernel(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	memFile := writeMemFile(t, dir)
	var phase atomic.Int32
	handler, err := startUffdHandler("uffd.sock", memFile, &phase, nil)
	assert.NilError(t, err)
	mem := setupGuestMemory(t, "uffd.sock", 3)
	assert.NilError(t, <-handler.ready)
	assert.NilError(t, (<-handler.filled).err)
	_ = mem[0]

	assert.NilError(t, unix.Madvise(mem[:testPage], unix.MADV_DONTNEED))
	after := mem[0]
	handler.close()
	report, _ := handler.report()

	assert.Equal(t, after, byte(0))
	assert.Equal(t, report.Removes, 1)
	assert.Equal(t, report.RemovedBytes, uint64(testPage))
	assert.Equal(t, len(report.Errors), 0)
}

func TestUffdHandlerSignalsAFaultItCannotResolve(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	memFile := writeMemFile(t, dir)
	var phase atomic.Int32
	handler, err := startUffdHandler("uffd.sock", memFile, &phase, nil)
	assert.NilError(t, err)
	mem := setupGuestMemory(t, "uffd.sock", 2)
	assert.NilError(t, <-handler.ready)
	assert.NilError(t, (<-handler.filled).err)
	// the fault blocks until close releases the uffd, so it runs aside; the
	// read sits in its own statement, because a send passes its value by
	// address and would read the page only at the receive
	touched := make(chan byte)
	go func() {
		value := mem[2*testPage]
		touched <- value
	}()

	select {
	case <-handler.failed:
	case <-time.After(10 * time.Second):
		t.Fatal("the handler did not signal the unresolved fault")
	}
	failure := handler.err()
	handler.close()
	<-touched

	assert.ErrorContains(t, failure, "outside every region")
}

func TestParseUffdMsgsReadsAFaultAndARemove(t *testing.T) {
	raw := make([]byte, 2*uffdMsgSize)
	raw[0] = uffdEventPagefault
	binary.LittleEndian.PutUint64(raw[16:24], 0x7f0000201234)
	raw[uffdMsgSize] = uffdEventRemove
	binary.LittleEndian.PutUint64(raw[uffdMsgSize+8:uffdMsgSize+16], 0x7f0000400000)
	binary.LittleEndian.PutUint64(raw[uffdMsgSize+16:uffdMsgSize+24], 0x7f0000600000)

	msgs := parseUffdMsgs(raw)

	assert.Equal(t, len(msgs), 2)
	assert.Equal(t, msgs[0], uffdMsg{event: uffdEventPagefault, address: 0x7f0000201234})
	assert.Equal(t, msgs[1], uffdMsg{event: uffdEventRemove, address: 0x7f0000400000, end: 0x7f0000600000})
}

func TestPageOfRoundsAFaultDownToItsPage(t *testing.T) {
	h := &uffdHandler{pageSize: 2 << 20, regions: []guestRegion{
		{BaseHostVirtAddr: 0x7f0000000000, Size: 8 << 20, Offset: 0, PageSize: 2 << 20},
		{BaseHostVirtAddr: 0x7f1000000000, Size: 4 << 20, Offset: 8 << 20, PageSize: 2 << 20},
	}}

	page, dst, ok := h.pageOf(0x7f1000201234)

	assert.Assert(t, ok)
	assert.Equal(t, page, int64(10<<20))
	assert.Equal(t, dst, uint64(0x7f1000200000))
}

func TestPageOfRefusesAnAddressOutsideEveryRegion(t *testing.T) {
	h := &uffdHandler{pageSize: 4096, regions: []guestRegion{{BaseHostVirtAddr: 0x10000, Size: 0x2000, PageSize: 4096}}}

	_, _, ok := h.pageOf(0x12000)

	assert.Assert(t, !ok)
}
