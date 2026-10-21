// Package disk grows the guest's ext4 root to the size of its block device.
// The host grows the disk file; the filesystem follows with an online resize,
// so no resize2fs is needed in the image.
package disk

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

// _IOW('f', 16, __u64); x/sys/unix lacks it.
const ext4ResizeFS = 0x40086610

const pollInterval = 20 * time.Millisecond

// The user disk: its size in 512-byte sectors, and the device, whose ext4
// superblock holds the filesystem's size in blocks.
const (
	sizePath   = "/sys/block/vda/size"
	devicePath = "/dev/vda"
)

// device is a block device and the ext4 filesystem mounted from it.
type device struct {
	sizePath   string
	devicePath string
	resizeFS   func(mountpoint string, blocks uint64) error
	blockSize  func(mountpoint string) (int64, error)
}

// userDisk is the guest's user disk.
func userDisk() *device {
	return &device{sizePath: sizePath, devicePath: devicePath, resizeFS: ioctlResize, blockSize: statBlockSize}
}

// Grow resizes the ext4 filesystem mounted at mountpoint to fill the device.
func Grow(mountpoint string) error {
	return userDisk().grow(mountpoint)
}

// WaitAndGrow waits until the device reports at least target bytes, then
// grows the filesystem at mountpoint. After the host changes the drive, the
// guest reads the new capacity on its own time.
func WaitAndGrow(mountpoint string, target int64, timeout time.Duration) error {
	return userDisk().waitAndGrow(mountpoint, target, timeout)
}

func (d *device) grow(mountpoint string) error {
	bytes, err := d.readBytes()
	if err != nil {
		return err
	}
	return d.growTo(mountpoint, bytes)
}

func (d *device) waitAndGrow(mountpoint string, target int64, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		bytes, err := d.readBytes()
		if err != nil {
			return err
		}
		if bytes >= target {
			return d.growTo(mountpoint, bytes)
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the disk is %d bytes after %s, not %d", bytes, timeout, target)
		}
		time.Sleep(pollInterval)
	}
}

// growTo skips the resize when the filesystem fills the device already: the
// ioctl keeps the size then, but flushes the journal all the same, and that
// held up every boot. A superblock it cannot read leaves the call to ext4.
func (d *device) growTo(mountpoint string, bytes int64) error {
	size, err := d.blockSize(mountpoint)
	if err != nil {
		return err
	}
	blocks := uint64(bytes / size)
	if have, err := readFSBlocks(d.devicePath); err == nil && have == blocks {
		return nil
	}
	if err := d.resizeFS(mountpoint, blocks); err != nil {
		return fmt.Errorf("EXT4_IOC_RESIZE_FS to %d bytes: %w", bytes, err)
	}
	return nil
}

func (d *device) readBytes() (int64, error) {
	raw, err := os.ReadFile(d.sizePath)
	if err != nil {
		return 0, err
	}
	sectors, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", d.sizePath, err)
	}
	return sectors * 512, nil
}

func statBlockSize(mountpoint string) (int64, error) {
	var st unix.Statfs_t
	if err := unix.Statfs(mountpoint, &st); err != nil {
		return 0, err
	}
	return st.Bsize, nil
}

func ioctlResize(mountpoint string, blocks uint64) error {
	f, err := os.Open(mountpoint)
	if err != nil {
		return err
	}
	defer f.Close()
	// the argument is a pointer to the new block count, a __u64
	_, _, errno := unix.Syscall(unix.SYS_IOCTL, f.Fd(), ext4ResizeFS, uintptr(unsafe.Pointer(&blocks)))
	if errno != 0 {
		return errno
	}
	return nil
}

// The fields of the ext4 superblock that give the filesystem's size; the
// superblock starts 1024 bytes into the device.
const (
	superblockOffset = 1024
	superblockBytes  = 1024
	ext4Magic        = 0xef53
	incompat64Bit    = 0x80
)

// readFSBlocks reads the filesystem's size in blocks from the superblock on
// dev. The read goes through the device's page cache, which holds the
// mounted filesystem's own superblock buffer, so it sees a grow at once.
func readFSBlocks(dev string) (uint64, error) {
	f, err := os.Open(dev)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sb := make([]byte, superblockBytes)
	if _, err := f.ReadAt(sb, superblockOffset); err != nil {
		return 0, fmt.Errorf("%s: superblock: %w", dev, err)
	}
	if binary.LittleEndian.Uint16(sb[0x38:]) != ext4Magic {
		return 0, errors.New(dev + ": no ext4 superblock")
	}
	blocks := uint64(binary.LittleEndian.Uint32(sb[0x04:]))
	if binary.LittleEndian.Uint32(sb[0x60:])&incompat64Bit != 0 {
		blocks |= uint64(binary.LittleEndian.Uint32(sb[0x150:])) << 32
	}
	return blocks, nil
}
