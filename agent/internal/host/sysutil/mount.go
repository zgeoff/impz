package sysutil

import (
	"fmt"

	"golang.org/x/sys/unix"
)

// MountOnce mounts fstype on target unless something is already mounted
// there. The kernel auto-mounts devtmpfs on /dev (DEVTMPFS_MOUNT).
func MountOnce(source, target, fstype string, flags uintptr, data string) error {
	if Mounted(target) {
		return nil
	}
	if err := unix.Mount(source, target, fstype, flags, data); err != nil {
		return fmt.Errorf("mount %s on %s: %w", fstype, target, err)
	}
	return nil
}

// Mounted reports whether path is a mountpoint: its device differs from
// its parent's.
func Mounted(path string) bool {
	var st, parent unix.Stat_t
	if unix.Stat(path, &st) != nil || unix.Stat(path+"/..", &parent) != nil {
		return false
	}
	return st.Dev != parent.Dev
}
