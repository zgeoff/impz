package memory

import (
	"log"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/zgeoff/impz/agent/internal/feature/inner"
	"github.com/zgeoff/impz/agent/internal/host/cmdline"
)

const (
	// left to the agent and the kernel, so a user process that eats the rest
	// meets the OOM killer inside its cgroup, not the agent
	userReserve = 64 << 20

	// noMemoryLimit is memory.max's "max"
	noMemoryLimit = math.MaxInt64

	// a plug of 256 MiB comes in well under a second
	memoryFollowInterval = 250 * time.Millisecond
)

func SetUserMax() {
	if limit := userMemoryMax(Total()); limit != noMemoryLimit {
		writeUserMemoryMax(limit)
	}
}

func Total() int64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 && f[0] == "MemTotal:" {
			kib, _ := strconv.ParseInt(f[1], 10, 64)
			return kib << 10
		}
	}
	return 0
}

func userMemoryMax(total int64) int64 {
	if total <= 2*userReserve {
		return noMemoryLimit
	}
	return total - userReserve
}

func writeUserMemoryMax(limit int64) {
	value := "max"
	if limit != noMemoryLimit {
		value = strconv.FormatInt(limit, 10)
	}
	if err := os.WriteFile(inner.CgroupDir+"/memory.max", []byte(value), 0); err != nil {
		log.Printf("boot: memory.max: %v", err)
	}
}

func userMemoryCurrent() (int64, error) {
	b, err := os.ReadFile(inner.CgroupDir + "/memory.current")
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(strings.TrimSpace(string(b)), 10, 64)
}

// See docs/architecture/lifecycle/elastic-memory.md#how-the-guest-grows.
func Follower(p cmdline.Params) func() {
	if !p.HotplugMemory {
		return nil
	}
	return func() {
		ticker := time.NewTicker(memoryFollowInterval)
		followMemTotal(ticker.C, Total, userMemoryCurrent, writeUserMemoryMax)
	}
}

func followMemTotal(
	ticks <-chan time.Time,
	total func() int64,
	current func() (int64, error),
	write func(int64),
) {
	last := userMemoryMax(total())
	for range ticks {
		if next := nextUserMemoryMax(last, userMemoryMax(total()), current); next != last {
			write(next)
			last = next
		}
	}
}

// A cut never goes below the container's use plus the reserve, so it never
// makes the kernel kill a user process to fit. An unplug offlines memory only
// once the guest moved its pages away, but a cut does not rely on it.
func nextUserMemoryMax(last, target int64, current func() (int64, error)) int64 {
	if target >= last {
		return target
	}
	used, err := current()
	if err != nil {
		return last
	}
	return min(last, max(target, used+userReserve))
}
