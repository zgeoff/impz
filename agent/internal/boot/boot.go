// Package boot brings the guest up. The agent stays on the read-only system
// drive, mounts the user disk at /user, and runs user code in the inner
// container over it (docs/architecture/guest/agent.md#boot).
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
)

const (
	// agentRunSize caps the agent's own /run: its sockets and little else
	agentRunSize = "16m"
)

// setupAgentWorld mounts the agent's own filesystems on the system drive,
// which must contain the directories /dev, /proc, /sys, /run and /user,
// since it cannot be written. A boot template makes them before it parks.
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
	// favordynmods: without it, each move into a cgroup and each change of
	// a cgroup's controllers waits for an RCU grace period, which the boot
	// pays several times over in the inner container's start; a fork then
	// costs a little more. Only this mount, in the root cgroup namespace,
	// sets it: the container's mounts and docker's cannot clear it.
	if err := sysutil.MountOnce("cgroup2", cgroup.Root, "cgroup2",
		unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC|unix.MS_RELATIME, "nsdelegate,favordynmods"); err != nil {
		return err
	}
	if err := sysutil.MountOnce("tmpfs", "/run", "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0755,size="+agentRunSize); err != nil {
		return err
	}
	// the agent's own ptys, for an exec in its world
	if err := mkdirMount("devpts", "/dev/pts", "devpts", unix.MS_NOSUID|unix.MS_NOEXEC,
		"newinstance,ptmxmode=0666,mode=0620,gid=5"); err != nil {
		return err
	}
	// the read-only files, kept in memory beside the agent's /run so a full
	// tree never takes the agent's sockets' room; each inner container binds
	// it read-only
	if err := mkdirMount("tmpfs", files.Dir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV|unix.MS_NOEXEC,
		"mode=0755,size="+files.Size); err != nil {
		return err
	}
	return nil
}

// cacheFile reads the file at path through once, which leaves its pages in
// the page cache.
func cacheFile(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(io.Discard, f)
	return err
}

// growUserDisk grows the mounted user disk to its device: the host may have
// grown it since the last boot. A failed grow leaves the filesystem as it
// was, so the boot goes on.
func growUserDisk() {
	if err := disk.Grow(inner.UserRoot); err != nil {
		log.Printf("boot: grow %s: %v", inner.UserDisk, err)
	}
}

// protectAgent keeps the OOM killer off the agent: a user process that eats
// the guest's memory dies first.
func protectAgent() {
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("-1000"), 0); err != nil {
		log.Printf("boot: oom_score_adj: %v", err)
	}
}

// setupUserCgroup makes the inner container's cgroup with every controller
// and a memory limit that leaves some memory to the agent and the kernel.
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

// innerRunSize is the inner /run's size: a tenth of memory, as a user's
// /run full of files must not take the guest's memory.
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
