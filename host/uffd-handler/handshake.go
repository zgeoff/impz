package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"

	"golang.org/x/sys/unix"
)

// guestRegion is one entry of Firecracker's handshake. Firecracker v1.17 sends
// page_size in bytes.
type guestRegion struct {
	BaseHostVirtAddr uint64 `json:"base_host_virt_addr"`
	Size             uint64 `json:"size"`
	Offset           uint64 `json:"offset"`
	PageSize         uint64 `json:"page_size"`
}

type peerConn struct {
	uffd    int
	regions []guestRegion
	// a pidfd of the Firecracker that connected: it turns readable when that
	// process exits, and a kill through it cannot reach a reused pid
	pidfd int
}

// Firecracker sends its regions and the uffd in one message, with no reply.
const handshakeBytes = 64 << 10

func readHandshake(conn *net.UnixConn) (peerConn, error) {
	pidfd, err := openPeerPidfd(conn)
	if err != nil {
		return peerConn{}, err
	}
	uffd, regions, err := readRegions(conn)
	if err != nil {
		_ = unix.PidfdSendSignal(pidfd, unix.SIGKILL, nil, 0)
		unix.Close(pidfd)
		return peerConn{}, err
	}
	return peerConn{uffd: uffd, regions: regions, pidfd: pidfd}, nil
}

func openPeerPidfd(conn *net.UnixConn) (int, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return -1, err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return -1, err
	}
	if credErr != nil {
		return -1, fmt.Errorf("SO_PEERCRED: %w", credErr)
	}
	pidfd, err := unix.PidfdOpen(int(cred.Pid), 0)
	if err != nil {
		return -1, fmt.Errorf("pidfd_open %d: %w", cred.Pid, err)
	}
	return pidfd, nil
}

func readRegions(conn *net.UnixConn) (int, []guestRegion, error) {
	buf := make([]byte, handshakeBytes)
	oob := make([]byte, unix.CmsgSpace(4))
	n, oobn, _, _, err := conn.ReadMsgUnix(buf, oob)
	if err != nil {
		return -1, nil, fmt.Errorf("uffd handshake: %w", err)
	}
	messages, err := unix.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(messages) != 1 {
		return -1, nil, fmt.Errorf("uffd handshake: no descriptor (%v)", err)
	}
	fds, err := unix.ParseUnixRights(&messages[0])
	if err != nil || len(fds) != 1 {
		return -1, nil, fmt.Errorf("uffd handshake: %d descriptors (%v)", len(fds), err)
	}
	var regions []guestRegion
	if err := json.Unmarshal(buf[:n], &regions); err != nil {
		unix.Close(fds[0])
		return -1, nil, fmt.Errorf("uffd handshake %q: %w", buf[:n], err)
	}
	if len(regions) == 0 {
		unix.Close(fds[0])
		return -1, nil, errors.New("uffd handshake: no regions")
	}
	return fds[0], regions, nil
}
