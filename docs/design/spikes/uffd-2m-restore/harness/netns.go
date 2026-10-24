package main

import (
	"os"
	"os/exec"
	"syscall"
	"unsafe"

	"golang.org/x/sys/unix"
)

const netnsEnv = "UFFD_SPIKE_NETNS"

// The harness runs its VMs in a network namespace of its own, so the tap it
// makes goes when the harness exits and the host's interfaces never change.
func reexecInNetns() error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(self, os.Args[1:]...) //nolint:gosec // G702: the harness runs itself again with its own arguments
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), netnsEnv+"=1")
	cmd.SysProcAttr = &syscall.SysProcAttr{Cloneflags: unix.CLONE_NEWNET, Pdeathsig: syscall.SIGKILL}
	return cmd.Run()
}

type ifreq struct {
	name  [unix.IFNAMSIZ]byte
	flags uint16
	_     [22]byte
}

// createTap makes a persistent tap and sets it up, then lets go of it, so
// Firecracker can attach to it by name.
func createTap(name string) error {
	tun, err := os.OpenFile("/dev/net/tun", os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer tun.Close()

	var req ifreq
	copy(req.name[:], name)
	req.flags = unix.IFF_TAP | unix.IFF_NO_PI | unix.IFF_VNET_HDR
	if err := ioctl(int(tun.Fd()), unix.TUNSETIFF, unsafe.Pointer(&req)); err != nil {
		return err
	}
	if err := unix.IoctlSetInt(int(tun.Fd()), unix.TUNSETPERSIST, 1); err != nil {
		return err
	}

	sock, err := unix.Socket(unix.AF_INET, unix.SOCK_DGRAM, 0)
	if err != nil {
		return err
	}
	defer unix.Close(sock)
	var up ifreq
	copy(up.name[:], name)
	up.flags = unix.IFF_UP
	return ioctl(sock, unix.SIOCSIFFLAGS, unsafe.Pointer(&up))
}

func ioctl(fd int, request uintptr, arg unsafe.Pointer) error {
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), request, uintptr(arg))
	if errno != 0 {
		return errno
	}
	return nil
}
