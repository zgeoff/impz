package main

import (
	"os/exec"
	"runtime"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
)

// serveInProcess serves memory that the test process registered, with the
// ranges the guest removed, until the returned stop ends a stand-in peer, so a
// fault the handler cannot serve fails the test rather than killing it.
func serveInProcess(t *testing.T, mem []byte, uffd int, removed []uffdMsg) func() error {
	t.Helper()
	source, err := openMemSource(writeMemFile(t, t.TempDir()))
	assert.NilError(t, err)
	t.Cleanup(source.close)
	regions := []guestRegion{{BaseHostVirtAddr: uint64(uintptr(unsafe.Pointer(&mem[0]))), Size: testPages * testPage, PageSize: testPage}}
	h, err := newHandler(uffd, regions, source)
	assert.NilError(t, err)
	h.removed = removed

	sleeper := exec.Command("sleep", "60")
	assert.NilError(t, sleeper.Start())
	t.Cleanup(func() {
		_ = sleeper.Process.Kill()
		_ = sleeper.Wait()
	})
	pidfd, err := unix.PidfdOpen(sleeper.Process.Pid, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Close(pidfd) })

	done := make(chan error, 1)
	go func() { done <- h.serve(pidfd) }()
	return func() error {
		_ = sleeper.Process.Kill()
		return <-done
	}
}

func registerTestMemory(t *testing.T) ([]byte, int) {
	t.Helper()
	mem, uffd, err := registerMemory()
	assert.NilError(t, err)
	t.Cleanup(func() {
		_ = unix.Munmap(mem)
		unix.Close(uffd)
	})
	return mem, uffd
}

func TestHandlerGivesARemovedRangeBackToTheKernel(t *testing.T) {
	mem, uffd := registerTestMemory(t)
	stop := serveInProcess(t, mem, uffd, nil)
	_ = mem[0]

	assert.NilError(t, unix.Madvise(mem[:testPage], unix.MADV_DONTNEED))
	after := mem[0]
	last := mem[2*testPage]

	assert.Equal(t, after, byte(0))
	assert.Equal(t, last, byte('c'))
	assert.NilError(t, stop())
}

// A kernel with per-VMA locks serves a fault without the mmap lock, so a fault
// can queue its message after an unregister wakes the range's waiters. A fresh
// mapping over the page leaves the queued fault in that state.
func TestHandlerWakesAFaultThatReachesItAfterItsRangeIsRemoved(t *testing.T) {
	mem, uffd := registerTestMemory(t)
	base := uint64(uintptr(unsafe.Pointer(&mem[0])))
	read := make(chan byte, 1)
	go func() {
		// Go's preemption signal interrupts a fault that nothing woke, and the
		// retried fault would pass without the wake; the thread ends with the
		// goroutine, so its mask goes with it
		runtime.LockOSThread()
		urgent := unix.Sigset_t{}
		urgent.Val[0] = 1 << (unix.SIGURG - 1)
		if err := unix.PthreadSigmask(unix.SIG_BLOCK, &urgent, nil); err != nil {
			read <- 0xff
			return
		}
		// a send passes its value by address, so the read sits in its own
		// statement and never faults while the channel is locked
		value := mem[0]
		read <- value
	}()
	pending := []unix.PollFd{{Fd: int32(uffd), Events: unix.POLLIN}}
	queued, err := unix.Poll(pending, 5000)
	assert.NilError(t, err)
	assert.Equal(t, queued, 1)
	_, err = unix.MmapPtr(-1, 0, unsafe.Pointer(&mem[0]), testPage, unix.PROT_READ|unix.PROT_WRITE, unix.MAP_PRIVATE|unix.MAP_ANONYMOUS|unix.MAP_FIXED)
	assert.NilError(t, err)
	stop := serveInProcess(t, mem, uffd, []uffdMsg{{event: uffdEventRemove, address: base, end: base + testPage}})

	var after byte
	select {
	case after = <-read:
	case <-time.After(5 * time.Second):
		t.Fatal("the fault on the remapped page never woke")
	}

	assert.Equal(t, after, byte(0))
	assert.NilError(t, stop())
}

func TestNewHandlerRefusesRegionsOfMixedPageSizes(t *testing.T) {
	source, err := openMemSource(writeMemFile(t, t.TempDir()))
	assert.NilError(t, err)
	t.Cleanup(source.close)
	regions := []guestRegion{
		{BaseHostVirtAddr: 0, Size: testPage, PageSize: testPage},
		{BaseHostVirtAddr: 1 << 30, Size: testPage, Offset: testPage, PageSize: 2 << 20},
	}

	_, err = newHandler(-1, regions, source)

	assert.ErrorContains(t, err, "regions of 4096 and 2097152 byte pages")
}

func TestParseUffdMsgsReadsAFaultAndARemove(t *testing.T) {
	raw := make([]byte, 2*uffdMsgSize)
	raw[0] = uffdEventPagefault
	raw[16] = 0x10
	raw[uffdMsgSize] = uffdEventRemove
	raw[uffdMsgSize+8] = 0x20
	raw[uffdMsgSize+16] = 0x30

	msgs := parseUffdMsgs(raw)

	assert.Equal(t, len(msgs), 2)
	assert.Equal(t, msgs[0], uffdMsg{event: uffdEventPagefault, address: 0x10})
	assert.Equal(t, msgs[1], uffdMsg{event: uffdEventRemove, address: 0x20, end: 0x30})
}

func TestFindPageRoundsAFaultDownToItsPage(t *testing.T) {
	h := handler{pageSize: testPage, regions: []guestRegion{{BaseHostVirtAddr: 0x10000, Size: 2 * testPage, Offset: 0x4000, PageSize: testPage}}}

	offset, dst, ok := h.findPage(0x11234)

	assert.Assert(t, ok)
	assert.Equal(t, offset, int64(0x5000))
	assert.Equal(t, dst, uint64(0x11000))
}

func TestReadDataPagesListsTheBlocksThatHoldData(t *testing.T) {
	source, err := openMemSource(writeMemFile(t, t.TempDir()))
	assert.NilError(t, err)
	t.Cleanup(source.close)

	pages, err := source.readDataPages(testPage)

	assert.NilError(t, err)
	assert.DeepEqual(t, pages, map[int64]bool{0: true, 2 * testPage: true})
}

func TestReadDataPagesRoundsDataOutToWholePages(t *testing.T) {
	source, err := openMemSource(writeMemFile(t, t.TempDir()))
	assert.NilError(t, err)
	t.Cleanup(source.close)

	pages, err := source.readDataPages(2 * testPage)

	assert.NilError(t, err)
	assert.DeepEqual(t, pages, map[int64]bool{0: true, 2 * testPage: true})
}
