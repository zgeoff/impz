package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"slices"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// From linux/userfaultfd.h, which golang.org/x/sys does not carry.
const (
	uffdEventPagefault = 0x12
	uffdEventRemove    = 0x15
	uffdMsgSize        = 32
	// _IOWR(0xAA, 0x03, struct uffdio_copy), _IOR(0xAA, 0x01, struct uffdio_range),
	// _IOR(0xAA, 0x02, struct uffdio_range)
	uffdioCopy       = 0xc028aa03
	uffdioUnregister = 0x8010aa01
	uffdioWake       = 0x8010aa02
)

type uffdioCopyArg struct {
	dst  uint64
	src  uint64
	len  uint64
	mode uint64
	copy int64
}

type uffdioRange struct {
	start uint64
	len   uint64
}

// guestRegion is one entry of Firecracker's handshake. page_size is in
// bytes, whatever Firecracker's docs say.
type guestRegion struct {
	BaseHostVirtAddr uint64 `json:"base_host_virt_addr"`
	Size             uint64 `json:"size"`
	Offset           uint64 `json:"offset"`
	PageSize         uint64 `json:"page_size"`
}

type uffdMsg struct {
	event   uint8
	address uint64
	end     uint64
	// the phase and the time at which the handler read a fault, which a
	// fault deferred to a later round keeps
	phase int32
	read  time.Time
}

func parseUffdMsgs(raw []byte) []uffdMsg {
	msgs := make([]uffdMsg, 0, len(raw)/uffdMsgSize)
	for offset := 0; offset+uffdMsgSize <= len(raw); offset += uffdMsgSize {
		msg := raw[offset : offset+uffdMsgSize]
		parsed := uffdMsg{event: msg[0]}
		switch parsed.event {
		case uffdEventPagefault:
			parsed.address = binary.LittleEndian.Uint64(msg[16:24])
		case uffdEventRemove:
			parsed.address = binary.LittleEndian.Uint64(msg[8:16])
			parsed.end = binary.LittleEndian.Uint64(msg[16:24])
		}
		msgs = append(msgs, parsed)
	}
	return msgs
}

// The boot's phases, which the runner sets as it goes and each fault is
// counted under.
const (
	phaseLoad int32 = iota
	phaseResumed
	phaseClaimed
	phaseAgent
	phaseCount
)

var phaseNames = [phaseCount]string{"load", "resumed", "claimed", "agent"}

type fault struct {
	page    int64
	phase   int32
	service time.Duration
}

type uffdHandler struct {
	listener *net.UnixListener
	memFile  *os.File
	src      []byte
	data     map[int64]bool
	zero     []byte
	phase    *atomic.Int32

	uffd     int
	regions  []guestRegion
	pageSize uint64
	// the ranges given back to the kernel, which the serve loop and the fill
	// both read; a lock of their own keeps a fault's service clear of mu
	goneMu sync.Mutex
	gone   []uffdMsg

	mu       sync.Mutex
	faults   []fault
	removes  int
	removed  uint64
	stale    int
	unknown  int
	copyErrs []string

	// failed closes on the first error, a fault the handler cannot
	// resolve, so the runner stops the VM rather than wait on it
	failed   chan struct{}
	failOnce sync.Once
	firstErr error

	// a test closes the handler before it asserts, and its cleanup closes
	// it again when an earlier step fails
	closeOnce sync.Once

	ready    chan error
	filled   chan fillResult
	done     chan struct{}
	finished chan struct{}
}

type fillResult struct {
	pages    int
	duration time.Duration
	err      error
}

// startUffdHandler listens where Firecracker's Uffd backend connects. With
// fill pages, it copies those pages in as soon as it holds the uffd, while
// it serves the faults that come meanwhile.
func startUffdHandler(socket, memFile string, phase *atomic.Int32, fill []int64) (*uffdHandler, error) {
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		return nil, err
	}
	file, err := os.Open(memFile)
	if err != nil {
		listener.Close()
		return nil, err
	}
	info, err := file.Stat()
	if err != nil {
		listener.Close()
		file.Close()
		return nil, err
	}
	// no MAP_POPULATE: a hole read through a mapping costs a page of page
	// cache, so a hole is copied from the zero buffer instead
	src, err := unix.Mmap(int(file.Fd()), 0, int(info.Size()), unix.PROT_READ, unix.MAP_PRIVATE)
	if err != nil {
		listener.Close()
		file.Close()
		return nil, err
	}

	h := &uffdHandler{
		listener: listener,
		memFile:  file,
		src:      src,
		phase:    phase,
		uffd:     -1,
		failed:   make(chan struct{}),
		ready:    make(chan error, 1),
		filled:   make(chan fillResult, 1),
		done:     make(chan struct{}),
		finished: make(chan struct{}),
	}
	go h.run(memFile, fill)
	return h, nil
}

func (h *uffdHandler) run(memFile string, fill []int64) {
	defer close(h.finished)
	// a setup error goes through recordError too: Firecracker can wait on a
	// page inside /snapshot/load, which only a kill releases
	if err := h.accept(); err != nil {
		h.recordError(err)
		h.ready <- err
		h.filled <- fillResult{err: err}
		return
	}
	data, err := readDataPages(memFile, int64(h.pageSize))
	if err != nil {
		h.recordError(err)
		h.ready <- err
		h.filled <- fillResult{err: err}
		return
	}
	h.data = make(map[int64]bool, len(data))
	for _, page := range data {
		h.data[page] = true
	}
	h.zero = make([]byte, h.pageSize)
	h.ready <- nil

	if fill == nil {
		h.filled <- fillResult{}
	} else {
		go h.fill(fill)
	}
	h.serve()
}

func (h *uffdHandler) accept() error {
	if err := h.listener.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		return err
	}
	conn, err := h.listener.AcceptUnix()
	if err != nil {
		return err
	}
	defer conn.Close()

	buf := make([]byte, 64<<10)
	oob := make([]byte, unix.CmsgSpace(4))
	n, oobn, _, _, err := conn.ReadMsgUnix(buf, oob)
	if err != nil {
		return err
	}
	messages, err := unix.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(messages) != 1 {
		return fmt.Errorf("uffd handshake: no descriptor (%v)", err)
	}
	fds, err := unix.ParseUnixRights(&messages[0])
	if err != nil || len(fds) != 1 {
		return fmt.Errorf("uffd handshake: %v", err)
	}
	h.uffd = fds[0]
	if err := json.Unmarshal(buf[:n], &h.regions); err != nil {
		return fmt.Errorf("uffd handshake %q: %w", buf[:n], err)
	}
	if len(h.regions) == 0 {
		return errors.New("uffd handshake: no regions")
	}
	h.pageSize = h.regions[0].PageSize
	return unix.SetNonblock(h.uffd, true)
}

// fill copies the pages in, offset order. A page that a fault copied first
// answers EEXIST, which counts as filled.
func (h *uffdHandler) fill(pages []int64) {
	started := time.Now()
	for _, page := range pages {
		addr, ok := h.addressOf(page)
		if !ok {
			continue
		}
		for {
			err := h.copyPage(page, addr)
			if errors.Is(err, unix.EAGAIN) {
				time.Sleep(10 * time.Microsecond)
				continue
			}
			// the guest removed the page, and its next fault zero-fills it
			if errors.Is(err, unix.ENOENT) && h.isGone(addr) {
				break
			}
			if err != nil {
				h.recordError(err)
				h.filled <- fillResult{err: err}
				return
			}
			break
		}
	}
	h.filled <- fillResult{pages: len(pages), duration: time.Since(started)}
}

func (h *uffdHandler) addressOf(page int64) (uint64, bool) {
	for _, r := range h.regions {
		if uint64(page) >= r.Offset && uint64(page) < r.Offset+r.Size {
			return r.BaseHostVirtAddr + uint64(page) - r.Offset, true
		}
	}
	return 0, false
}

func (h *uffdHandler) pageOf(addr uint64) (int64, uint64, bool) {
	aligned := addr &^ (h.pageSize - 1)
	for _, r := range h.regions {
		if aligned >= r.BaseHostVirtAddr && aligned < r.BaseHostVirtAddr+r.Size {
			return int64(r.Offset + aligned - r.BaseHostVirtAddr), aligned, true
		}
	}
	return 0, 0, false
}

func (h *uffdHandler) copyPage(page int64, dst uint64) error {
	source := h.zero
	if h.data[page] {
		source = h.src[page : page+int64(h.pageSize)]
	}
	arg := uffdioCopyArg{
		dst: dst,
		src: uint64(uintptr(unsafe.Pointer(&source[0]))),
		len: h.pageSize,
	}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioCopy, uintptr(unsafe.Pointer(&arg)))
	switch {
	case errno == 0, errno == unix.EEXIST:
		return nil
	case arg.copy == -int64(unix.EAGAIN), errno == unix.EAGAIN:
		return unix.EAGAIN
	default:
		return fmt.Errorf("UFFDIO_COPY page %#x: %w", page, errno)
	}
}

// serve reads every queued event before it copies anything: while a REMOVE
// waits in the queue each copy answers EAGAIN. A fault that answers EAGAIN
// waits for the next round.
func (h *uffdHandler) serve() {
	buf := make([]byte, uffdMsgSize*64)
	var deferred []uffdMsg
	pollFds := []unix.PollFd{{Fd: int32(h.uffd), Events: unix.POLLIN}}
	for {
		select {
		case <-h.done:
			return
		default:
		}
		timeout := 20
		if len(deferred) > 0 {
			timeout = 0
		}
		if _, err := unix.Poll(pollFds, timeout); err != nil && !errors.Is(err, unix.EINTR) {
			h.recordError(err)
			return
		}
		var fresh []uffdMsg
		for {
			n, err := unix.Read(h.uffd, buf)
			if n > 0 {
				fresh = append(fresh, parseUffdMsgs(buf[:n])...)
			}
			if err != nil || n < len(buf) {
				break
			}
		}
		deferred = h.serveRound(fresh, deferred)
	}
}

// serveRound handles the events of one read, after the faults deferred from
// the round before, and returns the faults to retry. It stamps each fresh
// fault with the phase it came in: a copy wakes the guest, which can move the
// runner to its next phase before the fault is recorded.
func (h *uffdHandler) serveRound(fresh, deferred []uffdMsg) []uffdMsg {
	read := time.Now()
	phase := h.phase.Load()
	for i := range fresh {
		fresh[i].phase, fresh[i].read = phase, read
	}
	msgs := append(deferred, fresh...)
	for _, msg := range msgs {
		if msg.event == uffdEventRemove {
			h.unregister(msg.address, msg.end)
			h.goneMu.Lock()
			h.gone = append(h.gone, msg)
			h.goneMu.Unlock()
		}
	}
	var retry []uffdMsg
	for _, msg := range msgs {
		switch msg.event {
		case uffdEventRemove:
		case uffdEventPagefault:
			// the guest dropped the page, and the kernel serves the next fault
			// on an unregistered range, so a copy there only fails. A fault
			// that came in before the unregister can be read a round later.
			// A kernel with per-VMA locks can queue one after the unregister
			// woke the range, and it waits until the handler wakes it.
			if h.isGone(msg.address) {
				h.wake(msg.address)
				h.mu.Lock()
				h.stale++
				h.mu.Unlock()
				continue
			}
			if !h.serveFault(msg) {
				retry = append(retry, msg)
			}
		default:
			h.mu.Lock()
			h.unknown++
			h.mu.Unlock()
		}
	}
	return retry
}

func (h *uffdHandler) serveFault(msg uffdMsg) bool {
	page, dst, ok := h.pageOf(msg.address)
	if !ok {
		h.recordError(fmt.Errorf("fault at %#x outside every region", msg.address))
		return true
	}
	err := h.copyPage(page, dst)
	if errors.Is(err, unix.EAGAIN) {
		return false
	}
	if err != nil {
		h.recordError(err)
		return true
	}
	h.mu.Lock()
	h.faults = append(h.faults, fault{page: page, phase: msg.phase, service: time.Since(msg.read)})
	h.mu.Unlock()
	return true
}

// unregister gives a removed range back to the kernel, which zero-fills
// its next fault, as Firecracker's example handler does.
func (h *uffdHandler) unregister(start, end uint64) {
	arg := uffdioRange{start: start, len: end - start}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioUnregister, uintptr(unsafe.Pointer(&arg)))
	h.mu.Lock()
	h.removes++
	h.removed += end - start
	h.mu.Unlock()
	if errno != 0 {
		h.recordError(fmt.Errorf("UFFDIO_UNREGISTER %#x-%#x: %w", start, end, errno))
	}
}

func (h *uffdHandler) isGone(addr uint64) bool {
	h.goneMu.Lock()
	defer h.goneMu.Unlock()
	return slices.ContainsFunc(h.gone, func(r uffdMsg) bool { return addr >= r.address && addr < r.end })
}

// wake releases a fault on a range the handler gave back, which the kernel
// then zero-fills; the range takes the kernel's page alignment
func (h *uffdHandler) wake(addr uint64) {
	kernelPage := uint64(os.Getpagesize())
	arg := uffdioRange{start: addr &^ (kernelPage - 1), len: kernelPage}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioWake, uintptr(unsafe.Pointer(&arg)))
	if errno != 0 {
		h.recordError(fmt.Errorf("UFFDIO_WAKE %#x: %w", addr, errno))
	}
}

func (h *uffdHandler) recordError(err error) {
	h.mu.Lock()
	h.copyErrs = append(h.copyErrs, err.Error())
	h.mu.Unlock()
	h.failOnce.Do(func() {
		h.mu.Lock()
		h.firstErr = err
		h.mu.Unlock()
		close(h.failed)
	})
}

// err returns the handler's first error, nil while it has none.
func (h *uffdHandler) err() error {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.firstErr
}

func (h *uffdHandler) close() {
	h.closeOnce.Do(func() {
		close(h.done)
		h.listener.Close()
		<-h.finished
		if h.uffd >= 0 {
			unix.Close(h.uffd)
		}
		_ = unix.Munmap(h.src)
		h.memFile.Close()
	})
}

type faultReport struct {
	PageSize     uint64         `json:"page_size"`
	ByPhase      map[string]int `json:"by_phase"`
	ServiceP50Us float64        `json:"service_p50_us"`
	ServiceMaxUs float64        `json:"service_max_us"`
	ServiceSumMs float64        `json:"service_sum_ms"`
	Removes      int            `json:"removes"`
	RemovedBytes uint64         `json:"removed_bytes"`
	StaleFaults  int            `json:"stale_faults"`
	Unknown      int            `json:"unknown_events"`
	Errors       []string       `json:"errors,omitempty"`
}

func (h *uffdHandler) report() (faultReport, []int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := faultReport{
		PageSize:     h.pageSize,
		ByPhase:      map[string]int{"load": 0, "resumed": 0, "claimed": 0, "agent": 0},
		Removes:      h.removes,
		RemovedBytes: h.removed,
		StaleFaults:  h.stale,
		Unknown:      h.unknown,
		Errors:       h.copyErrs,
	}
	// two vCPUs can fault on one page before its copy lands, so a page
	// counts once, under the phase of its first fault
	services := make([]float64, 0, len(h.faults))
	seen := make(map[int64]bool, len(h.faults))
	pages := make([]int64, 0, len(h.faults))
	var sum time.Duration
	for _, f := range h.faults {
		services = append(services, float64(f.service.Microseconds()))
		sum += f.service
		if seen[f.page] {
			continue
		}
		seen[f.page] = true
		r.ByPhase[phaseNames[f.phase]]++
		if f.phase < phaseAgent {
			pages = append(pages, f.page)
		}
	}
	if len(services) > 0 {
		r.ServiceP50Us = median(services)
		r.ServiceMaxUs = slices.Max(services)
	}
	r.ServiceSumMs = float64(sum.Microseconds()) / 1000
	return r, pages
}
