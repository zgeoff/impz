package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"slices"
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

type uffdMsg struct {
	event   uint8
	address uint64
	end     uint64
}

type handler struct {
	uffd     int
	regions  []guestRegion
	pageSize uint64
	source   *memSource
	data     map[int64]bool
	zero     []byte
	// the ranges the guest gave back, which the kernel zero-fills from then on
	removed []uffdMsg
}

func newHandler(uffd int, regions []guestRegion, source *memSource) (*handler, error) {
	pageSize := regions[0].PageSize
	if pageSize == 0 || pageSize&(pageSize-1) != 0 {
		return nil, fmt.Errorf("uffd handshake: page size %d is not a power of two", pageSize)
	}
	for _, r := range regions {
		if r.PageSize != pageSize {
			return nil, fmt.Errorf("uffd handshake: regions of %d and %d byte pages", pageSize, r.PageSize)
		}
		if r.Offset+r.Size > uint64(len(source.mapped)) {
			return nil, fmt.Errorf("uffd handshake: a region ends at %d, past the memory file's %d bytes", r.Offset+r.Size, len(source.mapped))
		}
	}
	data, err := source.readDataPages(int64(pageSize))
	if err != nil {
		return nil, err
	}
	if err := unix.SetNonblock(uffd, true); err != nil {
		return nil, err
	}
	return &handler{
		uffd:     uffd,
		regions:  regions,
		pageSize: pageSize,
		source:   source,
		data:     data,
		zero:     make([]byte, pageSize),
	}, nil
}

// serve answers faults until the process behind pidfd exits, which ends the
// guest's memory and returns nil. A fault it cannot answer returns an error,
// because the guest would wait on that fault forever.
func (h *handler) serve(pidfd int) error {
	buf := make([]byte, uffdMsgSize*64)
	var deferred []uffdMsg
	pollFds := []unix.PollFd{
		{Fd: int32(h.uffd), Events: unix.POLLIN},
		{Fd: int32(pidfd), Events: unix.POLLIN},
	}
	for {
		timeout := -1
		if len(deferred) > 0 {
			timeout = 0
		}
		if _, err := unix.Poll(pollFds, timeout); err != nil {
			if errors.Is(err, unix.EINTR) {
				continue
			}
			return fmt.Errorf("poll: %w", err)
		}
		if pollFds[1].Revents != 0 {
			return nil
		}
		fresh, err := h.readMsgs(buf)
		if err != nil {
			return err
		}
		deferred, err = h.serveRound(append(deferred, fresh...))
		if err != nil {
			return err
		}
	}
}

func (h *handler) readMsgs(buf []byte) ([]uffdMsg, error) {
	var msgs []uffdMsg
	for {
		n, err := unix.Read(h.uffd, buf)
		if n > 0 {
			msgs = append(msgs, parseUffdMsgs(buf[:n])...)
		}
		if errors.Is(err, unix.EAGAIN) || (err == nil && n < len(buf)) {
			return msgs, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read uffd: %w", err)
		}
	}
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

// serveRound unregisters every removed range before it copies anything: while
// a REMOVE waits in the queue, each copy answers EAGAIN. It returns the faults
// whose copy answered EAGAIN, for the next round.
func (h *handler) serveRound(msgs []uffdMsg) ([]uffdMsg, error) {
	for _, msg := range msgs {
		if msg.event == uffdEventRemove {
			if err := h.unregister(msg); err != nil {
				return nil, err
			}
		}
	}
	var retry []uffdMsg
	for _, msg := range msgs {
		switch msg.event {
		case uffdEventRemove:
		case uffdEventPagefault:
			// a fault queued before its range's unregister, or after the
			// unregister's wake on a kernel with per-VMA locks, sleeps until
			// it is woken, and a copy into the range fails
			if h.isRemoved(msg.address) {
				if err := h.wake(msg.address); err != nil {
					return nil, err
				}
				continue
			}
			copied, err := h.serveFault(msg.address)
			if err != nil {
				return nil, err
			}
			if !copied {
				retry = append(retry, msg)
			}
		default:
			fmt.Fprintf(os.Stderr, "uffd-handler: ignored uffd event %#x\n", msg.event)
		}
	}
	return retry, nil
}

func (h *handler) serveFault(address uint64) (bool, error) {
	offset, dst, ok := h.findPage(address)
	if !ok {
		return false, fmt.Errorf("fault at %#x outside every region", address)
	}
	source := h.zero
	if h.data[offset] {
		source = h.source.mapped[offset : offset+int64(h.pageSize)]
	}
	arg := uffdioCopyArg{
		dst: dst,
		src: uint64(uintptr(unsafe.Pointer(&source[0]))),
		len: h.pageSize,
	}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioCopy, uintptr(unsafe.Pointer(&arg)))
	switch {
	case errno == 0, errno == unix.EEXIST:
		return true, nil
	case errno == unix.EAGAIN, arg.copy == -int64(unix.EAGAIN):
		return false, nil
	default:
		return false, fmt.Errorf("UFFDIO_COPY at %#x: %w", dst, errno)
	}
}

// findPage returns the memory file's offset and the guest page's address for
// a fault address.
func (h *handler) findPage(address uint64) (int64, uint64, bool) {
	aligned := address &^ (h.pageSize - 1)
	for _, r := range h.regions {
		if aligned >= r.BaseHostVirtAddr && aligned < r.BaseHostVirtAddr+r.Size {
			return int64(r.Offset + aligned - r.BaseHostVirtAddr), aligned, true
		}
	}
	return 0, 0, false
}

// unregister gives a removed range back to the kernel, which zero-fills its
// next fault, as Firecracker's example handler does.
func (h *handler) unregister(msg uffdMsg) error {
	h.removed = append(h.removed, msg)
	arg := uffdioRange{start: msg.address, len: msg.end - msg.address}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioUnregister, uintptr(unsafe.Pointer(&arg)))
	if errno != 0 {
		return fmt.Errorf("UFFDIO_UNREGISTER %#x-%#x: %w", msg.address, msg.end, errno)
	}
	return nil
}

func (h *handler) isRemoved(address uint64) bool {
	return slices.ContainsFunc(h.removed, func(r uffdMsg) bool { return address >= r.address && address < r.end })
}

// UFFDIO_WAKE refuses a range that is not aligned to the kernel's page size,
// which is smaller than a guest's huge page.
func (h *handler) wake(address uint64) error {
	kernelPage := uint64(os.Getpagesize())
	arg := uffdioRange{start: address &^ (kernelPage - 1), len: kernelPage}
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(h.uffd), uffdioWake, uintptr(unsafe.Pointer(&arg)))
	if errno != 0 {
		return fmt.Errorf("UFFDIO_WAKE %#x: %w", address, errno)
	}
	return nil
}
