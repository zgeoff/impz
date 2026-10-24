package outer

import (
	"errors"
	"fmt"
	"os"
	"strconv"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/host/cgroup"
	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
)

const (
	// memory.max keeps a runaway outer command from taking the memory the
	// agent needs
	CgroupDir = cgroup.Root + "/outer"
	memoryMax = 32 << 20

	// a tmpfs of its own, as the system drive is read-only and the agent's
	// /run holds its sockets
	RunDir  = "/run/outer"
	runSize = "8m"

	Command = "outer"
)

func Image() *imagecfg.Live {
	return imagecfg.NewLive(imagecfg.Config{
		Env:     []string{"PATH=/bin", "HOME=" + RunDir, "TMPDIR=" + RunDir},
		Workdir: "/",
	})
}

func Setup() (*cgroup.Tree, error) {
	tree, err := cgroup.NewLimitedTree(CgroupDir, limitMemory)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(RunDir, 0o700); err != nil {
		return nil, err
	}
	if err := unix.Mount("tmpfs", RunDir, "tmpfs", unix.MS_NOSUID|unix.MS_NODEV, "mode=0700,size="+runSize); err != nil {
		return nil, fmt.Errorf("mount %s: %w", RunDir, err)
	}
	return tree, nil
}

// Before each outer exec too: a root shell may have removed the cgroup, and
// the tree makes it again.
func limitMemory(dir string) error {
	if err := os.WriteFile(dir+"/memory.max", []byte(strconv.Itoa(memoryMax)), 0); err != nil {
		return fmt.Errorf("memory.max: %w", err)
	}
	return nil
}

type Runner struct {
	Next proc.Runner
}

// Resolved here, so a missing command fails as EXEC_FAILED.
func (r Runner) Start(s proc.Spec) (*proc.Process, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	if s.Cgroup == nil {
		return nil, errors.New("an outer exec needs its cgroup")
	}
	path, err := proc.LookPath(s.Argv[0], s.Env)
	if err != nil {
		return nil, err
	}
	s.Argv = append([]string{"imp-agent", Command, path}, s.Argv...)
	s.Helper = true
	s.RequireCgroup = true
	return r.Next.Start(s)
}

// Every child inherits the agent's shield from the OOM killer. Given up here,
// in the child before the exec, nothing the command starts can inherit it.
func RunHelper(args []string) error {
	if len(args) < 2 {
		return errors.New("usage: imp-agent outer <path> <argv...>")
	}
	if err := os.WriteFile("/proc/self/oom_score_adj", []byte("0"), 0); err != nil {
		return err
	}
	return unix.Exec(args[0], args[1:], os.Environ())
}
