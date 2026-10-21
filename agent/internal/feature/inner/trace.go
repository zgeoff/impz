package inner

// TEMPORARY instrumentation for the restore's guest steps; reverted before
// merge.

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sys/unix"
)

// TraceMark is one point of a container start, on CLOCK_MONOTONIC.
type TraceMark struct {
	Name string
	Mono int64
}

var (
	traceMu    sync.Mutex
	traceMarks []TraceMark
	readyNote  string
)

// Mono reads CLOCK_MONOTONIC, which the agent and the inner init share.
func Mono() int64 {
	var ts unix.Timespec
	_ = unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts)
	return ts.Nano()
}

func traceAt(name string, mono int64) {
	traceMu.Lock()
	traceMarks = append(traceMarks, TraceMark{name, mono})
	traceMu.Unlock()
}

func trace(name string) { traceAt(name, Mono()) }

// TakeTrace returns the marks so far in time order and drops them.
func TakeTrace() []TraceMark {
	traceMu.Lock()
	defer traceMu.Unlock()
	out := traceMarks
	traceMarks = nil
	sort.SliceStable(out, func(i, j int) bool { return out[i].Mono < out[j].Mono })
	return out
}

func noteReady(marks ...TraceMark) {
	parts := make([]string, 0, len(marks))
	for _, m := range marks {
		parts = append(parts, fmt.Sprintf("%s=%d", m.Name, m.Mono))
	}
	readyNote = strings.Join(parts, ",")
}

func readNote(note string) {
	for _, part := range strings.Split(note, ",") {
		name, v, ok := strings.Cut(part, "=")
		if !ok {
			continue
		}
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			traceAt(name, n)
		}
	}
}
