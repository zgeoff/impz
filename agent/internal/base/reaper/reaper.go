package reaper

import (
	"errors"
	"os"
	"os/signal"
	"sync"
	"syscall"

	"github.com/zgeoff/impz/agent/internal/base/safe"
)

type Status struct {
	Pid    int
	Code   int
	Signal syscall.Signal
}

func statusFrom(pid int, ws syscall.WaitStatus) Status {
	if ws.Signaled() {
		return Status{Pid: pid, Code: -1, Signal: ws.Signal()}
	}
	return Status{Pid: pid, Code: ws.ExitStatus()}
}

// The agent is PID 1, so it inherits every orphan in the guest and must reap
// them. A process-wide wait4(-1) loop races with any per-child Wait, so
// nothing else in the agent may call Wait.
type Reaper struct {
	// mu is held across fork+register so the loop cannot reap a pid before
	// its waiter exists.
	mu      sync.Mutex
	waiters map[int]chan Status
}

func New() *Reaper {
	r := &Reaper{waiters: make(map[int]chan Status)}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGCHLD)
	// Each pass recovers on its own: a dead reap loop would leave every
	// later child unreaped and every waiter blocked.
	go func() {
		for range sigs {
			safe.Call("reaper", r.reapAll)
		}
	}()
	return r
}

func (r *Reaper) Start(start func() (int, error)) (int, <-chan Status, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	pid, err := start()
	if err != nil {
		return 0, nil, err
	}
	ch := make(chan Status, 1)
	r.waiters[pid] = ch
	return pid, ch, nil
}

// SIGCHLD coalesces, so one signal may stand for many exits.
func (r *Reaper) reapAll() {
	for {
		var ws syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &ws, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return
		}
		if !ws.Exited() && !ws.Signaled() {
			continue
		}
		r.mu.Lock()
		ch, ok := r.waiters[pid]
		delete(r.waiters, pid)
		r.mu.Unlock()
		// Unregistered pids are orphans reparented to PID 1; drop them.
		if ok {
			ch <- statusFrom(pid, ws)
		}
	}
}
