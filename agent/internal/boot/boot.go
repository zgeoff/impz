package boot

import (
	"fmt"
	"io"
	"log"
	"os"
	"strconv"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/feature/files"
	"github.com/zgeoff/impz/agent/internal/feature/inner"
	"github.com/zgeoff/impz/agent/internal/feature/memory"
	"github.com/zgeoff/impz/agent/internal/host/cgroup"
	"github.com/zgeoff/impz/agent/internal/host/disk"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const (
	agentRunSize = "16m"
)

// The system drive cannot be written, so it must already hold the
// directories /dev, /proc, /sys, /run and /user.
func setupAgentWorld() error {
	if err := sysutil.MountOnce("devtmpfs", "/dev", "devtmpfs", unix.MS_NOSUID, "mode=0755"); err != nil {
		return err
	}
	if err := sysutil.MountOnce("proc", "/proc", "proc", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	if err := sysutil.MountOnce("sysfs", "/sys", "sysfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC, ""); err != nil {
		return err
	}
	// favordynmods: without it, each cgroup move or controller change waits an
	// RCU grace period, paid many times in the inner container's start. Only
	// this root-namespace mount sets it; the container's and docker's cannot.
	if err := sysutil.MountOnce("cgroup2", cgroup.Root, "cgroup2",
		unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC|unix.MS_RELATIME, "nsdelegate,favordynmods"); err != nil {
		return err
	}
	if err := sysutil.MountOnce("tmpfs", "/run", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755,size="+agentRunSize); err != nil {
		return err
	}
	if err := mkdirMount("devpts", "/dev/pts", "devpts", unix.MS_NOSUID|unix.MS_NOEXEC,
		"newinstance,ptmxmode=0666,mode=0620,gid=5"); err != nil {
		return err
	}
	// a tmpfs of its own, so a full tree never takes the room of the agent's
	// sockets in /run
	if err := mkdirMount("tmpfs", files.Dir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC,
		"mode=0755,size="+files.Size); err != nil {
		return err
	}
	return nil
}

func parkTemplate(agentBinary string, park func() (*proto.Claim, error)) (*proto.Claim, error) {
	// The code the agent and the inner init first run after a claim would
	// page in from the squashfs system drive, one block at a time behind its
	// one decompressor; cached here, the snapshot holds it.
	if err := cacheFile(agentBinary); err != nil {
		log.Printf("boot: cache %s: %v", agentBinary, err)
	}
	return park()
}

func cacheFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(io.Discard, f)
	return err
}

// The host may have grown the disk since the last boot. A failed grow leaves
// the filesystem as it was, so the boot goes on.
func growUserDisk() {
	if err := disk.Grow(inner.UserRoot); err != nil {
		log.Printf("boot: grow %s: %v", inner.UserDisk, err)
	}
}

func protectAgent() {
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("-1000"), 0); err != nil {
		log.Printf("boot: oom_score_adj: %v", err)
	}
}

func setupUserCgroup() error {
	if err := cgroup.EnableControllers(cgroup.Root, "boot: "); err != nil {
		return err
	}
	if err := os.MkdirAll(inner.CgroupDir, 0o755); err != nil {
		return err
	}
	memory.SetUserMax()
	return nil
}

// A user's /run full of files must not take the guest's memory.
func innerRunSize() string {
	if total := memory.Total(); total > 0 {
		return strconv.FormatInt(total/10, 10)
	}
	return ""
}

func mkdirMount(source, target, fstype string, flags uintptr, data string) error {
	if err := os.MkdirAll(target, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(source, target, fstype, flags, data); err != nil {
		return fmt.Errorf("mount %s on %s: %w", fstype, target, err)
	}
	return nil
}
