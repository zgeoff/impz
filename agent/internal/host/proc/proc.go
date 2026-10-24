package proc

import (
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/host/dropcaps"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
)

type Spec struct {
	Argv          []string
	Env           []string
	Dir           string
	Workdir       string
	User          string
	Cred          *syscall.Credential
	SetHome       bool
	Files         []*os.File
	TTY           bool
	Helper        bool
	Cgroup        *os.File
	RequireCgroup bool
	DropSysAdmin  bool
}

type Process struct {
	Pid      int
	Done     <-chan reaper.Status
	InCgroup bool
	ctl      control
}

type control interface {
	signal(pid int, sig syscall.Signal, group bool) error
}

var cgroupFallback sync.Once

func (p *Process) Signal(sig syscall.Signal) error {
	return p.ctl.signal(p.Pid, sig, true)
}

func (p *Process) Kill() error {
	return p.ctl.signal(p.Pid, syscall.SIGKILL, false)
}

// Only ESRCH means the process group is empty.
func (p *Process) GroupAlive() bool {
	return !errors.Is(p.ctl.signal(p.Pid, 0, true), syscall.ESRCH)
}

func NewProcess(pid int, done <-chan reaper.Status, signal func(pid int, sig syscall.Signal, group bool) error) *Process {
	return &Process{Pid: pid, Done: done, ctl: controlFunc(signal)}
}

type controlFunc func(pid int, sig syscall.Signal, group bool) error

func (f controlFunc) signal(pid int, sig syscall.Signal, group bool) error { return f(pid, sig, group) }

type Runner interface {
	Start(s Spec) (*Process, error)
}

var ErrDown = errors.New("the inner container is down")

type Direct struct {
	Reaper    *reaper.Reaper
	Agent     string
	AgentFile *os.File
}

func (d *Direct) Start(s Spec) (*Process, error) {
	if len(s.Argv) == 0 {
		return nil, errors.New("empty argv")
	}
	cred, home := s.Cred, ""
	if cred == nil {
		var err error
		if cred, home, err = LookupUser(s.User); err != nil {
			return nil, err
		}
	}
	env := s.Env
	if s.SetHome && s.User != "" {
		env = Merge(env, []string{"HOME=" + home})
	}
	files := s.Files
	path := ""
	argv := s.Argv
	// impd runs the agent by its path for sftp and tar: from the fd too, so
	// it works with the system drive unmounted inside
	if s.Helper || (d.AgentFile != nil && s.Argv[0] == d.Agent) {
		if s.DropSysAdmin {
			return nil, errors.New("a helper cannot drop CAP_SYS_ADMIN")
		}
		path, files = d.agentPath(files)
	} else {
		var err error
		if path, err = LookPath(s.Argv[0], env); err != nil {
			return nil, err
		}
	}
	if s.DropSysAdmin {
		if d.Agent == "" {
			return nil, errors.New("no agent binary to drop CAP_SYS_ADMIN with")
		}
		agentFd := -1
		if d.AgentFile != nil {
			agentFd = len(files)
		}
		argv = dropcaps.Argv(agentFd, cred, path, s.Argv)
		path, files = d.agentPath(files)
		// the helper starts as root and becomes the user itself
		cred = nil
	}
	dir := s.Dir
	if dir == "" {
		dir = "/"
		for _, d := range []string{s.Workdir, Get(env, "HOME")} {
			if fi, err := os.Stat(d); d != "" && err == nil && fi.IsDir() {
				dir = d
				break
			}
		}
	}
	fds := make([]uintptr, len(files))
	for i, f := range files {
		fds[i] = f.Fd()
	}
	pidfd := -1
	sys := &syscall.SysProcAttr{Credential: cred, Setpgid: !s.TTY, PidFD: &pidfd}
	if s.TTY {
		sys.Setsid = true
		sys.Setctty = true
		sys.Ctty = 0
	}
	if s.Cgroup != nil {
		sys.UseCgroupFD = true
		sys.CgroupFD = int(s.Cgroup.Fd())
	}
	attr := &syscall.ProcAttr{Dir: dir, Env: env, Files: fds, Sys: sys}
	inCgroup := s.Cgroup != nil
	pid, done, err := d.Reaper.Start(func() (int, error) {
		// syscall.ForkExec, not os/exec: exec.Cmd expects its own Wait call,
		// which would race with the reaper
		pid, err := syscall.ForkExec(path, argv, attr)
		if err == nil || !inCgroup || s.RequireCgroup {
			return pid, err
		}
		// No clone3, or a cgroup gone from under us: the command still runs,
		// and a stop falls back to its process group. An exec error (EACCES,
		// say) also lands here, and its retry fails the same way.
		sys.UseCgroupFD = false
		pid, retryErr := syscall.ForkExec(path, argv, attr)
		if retryErr == nil {
			inCgroup = false
			cgroupFallback.Do(func() {
				log.Printf("proc: cannot start in a cgroup (%v); execs run without one", err)
			})
		}
		return pid, retryErr
	})
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", s.Argv[0], err)
	}
	p := newDirectProcess(pid, pidfd, done)
	p.InCgroup = inCgroup
	return p, nil
}

func (d *Direct) agentPath(files []*os.File) (string, []*os.File) {
	if d.AgentFile == nil {
		return d.Agent, files
	}
	// the child's own fd of the binary: unmounting or replacing the path
	// inside cannot break a helper
	path := fmt.Sprintf("/proc/self/fd/%d", len(files))
	return path, append(append([]*os.File{}, files...), d.AgentFile)
}

// A pidfd until the child is reaped keeps a kill from reaching a process that
// reused the pid.
func newDirectProcess(pid, pidfd int, reaped <-chan reaper.Status) *Process {
	var mu sync.Mutex
	done := make(chan reaper.Status, 1)
	go func() {
		st := <-reaped
		mu.Lock()
		if pidfd >= 0 {
			unix.Close(pidfd)
			pidfd = -1
		}
		mu.Unlock()
		done <- st
	}()
	return NewProcess(pid, done, func(pid int, sig syscall.Signal, group bool) error {
		if group {
			return syscall.Kill(-pid, sig)
		}
		mu.Lock()
		defer mu.Unlock()
		if pidfd < 0 {
			return syscall.ESRCH
		}
		return unix.PidfdSendSignal(pidfd, sig, nil, 0)
	})
}

func LookPath(file string, env []string) (string, error) {
	if strings.Contains(file, "/") {
		return file, sysutil.CheckExecutable(file, os.Stat)
	}
	return sysutil.FindInPath(file, Get(env, "PATH"), os.Stat)
}

func Get(env []string, key string) string {
	for i := len(env) - 1; i >= 0; i-- {
		if k, v, ok := strings.Cut(env[i], "="); ok && k == key {
			return v
		}
	}
	return ""
}

func Merge(base, extra []string) []string {
	out := make([]string, 0, len(base)+len(extra))
	idx := make(map[string]int)
	for _, kv := range append(append([]string{}, base...), extra...) {
		k, _, _ := strings.Cut(kv, "=")
		if i, ok := idx[k]; ok {
			out[i] = kv
			continue
		}
		idx[k] = len(out)
		out = append(out, kv)
	}
	return out
}
