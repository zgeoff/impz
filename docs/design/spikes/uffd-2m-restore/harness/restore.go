package main

import (
	"bufio"
	"crypto/rand"
	"fmt"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// impd's template boot: BASE_BOOT_ARGS and imp.template=1, and the template
// tap's guest MAC.
const (
	templateBootArgs = "console=ttyS0 reboot=k panic=1 pci=off " +
		"i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd " +
		"root=/dev/vdb rootfstype=squashfs ro init=/imp-agent imp.template=1"
	templateMAC = "06:00:a9:fe:ff:fe"
	tapName     = "imp-tpl"
	// impd's VM_DEADLINES.agentMs and its claimed-agent deadline
	agentDeadline   = 15 * time.Second
	claimedDeadline = 10 * time.Second
)

type templatePaths struct {
	dir         string
	vmstate     string
	mem         string
	placeholder string
}

func newTemplatePaths(dir string) templatePaths {
	return templatePaths{
		dir:         dir,
		vmstate:     filepath.Join(dir, "vmstate"),
		mem:         filepath.Join(dir, "mem"),
		placeholder: filepath.Join(dir, "placeholder.ext4"),
	}
}

type buildOptions struct {
	firecracker string
	kernel      string
	system      string
	template    templatePaths
	vcpus       int
	memoryMiB   int
	hugePages   string
	minUptime   time.Duration
}

// buildTemplate builds a boot template as impd's createTemplateVm does: boot
// with imp.template=1, wait for the parked agent and the guest's age, pause,
// take a Full snapshot, then dig the memory file's holes.
func buildTemplate(o buildOptions) error {
	runDir := filepath.Join(o.template.dir, "build")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(o.template.placeholder, nil, 0o600); err != nil {
		return err
	}
	if err := os.Truncate(o.template.placeholder, 1<<20); err != nil {
		return err
	}

	vsock := filepath.Join(runDir, "vsock.sock")
	fc, err := startFirecracker(o.firecracker, filepath.Join(runDir, "api.sock"), filepath.Join(runDir, "firecracker.log"))
	if err != nil {
		return err
	}
	defer fc.stop()

	if err := fc.configure(vmShape{
		kernel: o.kernel, bootArgs: templateBootArgs, vcpus: o.vcpus, memoryMiB: o.memoryMiB,
		hugePages: o.hugePages, rootfs: o.template.placeholder, system: o.system,
		vsock: vsock, tap: tapName, guestMAC: templateMAC,
	}); err != nil {
		return err
	}
	if _, err := fc.send(http.MethodPut, "/actions", map[string]any{"action_type": "InstanceStart"}); err != nil {
		return err
	}
	if _, err := waitForAgent(vsock, waitOptions{deadline: agentDeadline, attempt: time.Second, maxDelay: 100 * time.Millisecond, parked: true}); err != nil {
		return err
	}
	for {
		answer, err := sendAgentRequest(vsock, map[string]any{"op": "ping"}, 2*time.Second)
		if err != nil {
			return err
		}
		if answer.UptimeMs == nil || time.Duration(*answer.UptimeMs)*time.Millisecond >= o.minUptime {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := fc.setState("Paused"); err != nil {
		return err
	}
	// a Full snapshot reads every guest page, so a 2M guest's dump takes a
	// hugetlb page for each block the guest never touched
	if _, err := fc.send(http.MethodPut, "/snapshot/create", map[string]any{
		"snapshot_type": "Full", "snapshot_path": o.template.vmstate,
		"mem_file_path": o.template.mem, "sync_snapshot_files": true,
	}); err != nil {
		return fmt.Errorf("%w (HugePages_Surp %d, free 2 MiB blocks %d)", err, readMeminfo("HugePages_Surp"), readFreeHugeBlocks())
	}
	fc.stop()
	if err := os.RemoveAll(runDir); err != nil {
		return err
	}
	return digHoles(o.template.mem)
}

type restoreOptions struct {
	label       string
	firecracker string
	template    templatePaths
	disk        string
	workDir     string
	// uffd restores through a handler; fill, when not nil, is what it
	// copies in before the resume
	uffd bool
	fill []int64
}

type marks struct {
	last  time.Time
	steps []step
}

type step struct {
	name string
	ms   float64
}

func (m *marks) mark(name string) {
	now := time.Now()
	m.steps = append(m.steps, step{name, roundMs(now.Sub(m.last))})
	m.last = now
}

func roundMs(d time.Duration) float64 {
	return math.Round(float64(d.Microseconds())/100) / 10
}

type fillReport struct {
	Pages int     `json:"pages"`
	Ms    float64 `json:"ms"`
}

type result struct {
	Label         string             `json:"label"`
	Run           int                `json:"run"`
	Marks         map[string]float64 `json:"marks"`
	Guest         map[string]float64 `json:"guest"`
	Fill          *fillReport        `json:"fill,omitempty"`
	Faults        *faultReport       `json:"faults,omitempty"`
	HugePagesSurp int                `json:"hugepages_surp"`
	AgentVersion  string             `json:"agent_version"`
}

// restoreOnce restores the template as impd's loadTemplateVm does and
// times the same steps: spawn, load, resume, parked, disk, patch, claim,
// agent and version. It returns the pages the boot faulted in up to the
// unparked agent.
func restoreOnce(o restoreOptions, run int) (result, []int64, error) {
	res := result{Label: o.label, Run: run, Marks: map[string]float64{}, Guest: map[string]float64{}}
	runDir := filepath.Join(o.workDir, fmt.Sprintf("%s-%d", o.label, run))
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return res, nil, err
	}
	disk := filepath.Join(runDir, "disk.ext4")
	if err := copySparse(o.disk, disk); err != nil {
		return res, nil, err
	}
	info, err := os.Stat(disk)
	if err != nil {
		return res, nil, err
	}

	var phase atomic.Int32
	var handler *uffdHandler
	if o.uffd {
		handler, err = startUffdHandler(filepath.Join(runDir, "uffd.sock"), o.template.mem, &phase, o.fill)
		if err != nil {
			return res, nil, err
		}
	}

	vsock := filepath.Join(runDir, "vsock.sock")
	logFile := filepath.Join(runDir, "firecracker.log")
	m := marks{last: time.Now()}
	fc, err := startFirecracker(o.firecracker, filepath.Join(runDir, "api.sock"), logFile)
	if err != nil {
		if handler != nil {
			handler.close()
		}
		return res, nil, err
	}
	m.mark("spawn")

	bootErr := bootClaimed(fc, handler, &phase, &m, &res, o, vsock, disk, info.Size())
	if bootErr == nil {
		res.HugePagesSurp = readMeminfo("HugePages_Surp")
	}
	fc.stop()
	var pages []int64
	if handler != nil {
		handler.close()
		report, faulted := handler.report()
		res.Faults = &report
		pages = faulted
	}
	for _, s := range m.steps {
		res.Marks[s.name] = s.ms
	}
	if bootErr != nil {
		tail, _ := os.ReadFile(logFile)
		return res, nil, fmt.Errorf("%s run %d: %w\n%s", o.label, run, bootErr, lastLines(string(tail), 10))
	}
	return res, pages, os.RemoveAll(runDir)
}

func bootClaimed(fc *firecracker, handler *uffdHandler, phase *atomic.Int32, m *marks, res *result, o restoreOptions, vsock, disk string, diskBytes int64) error {
	backendType, backendPath := "File", o.template.mem
	if handler != nil {
		backendType, backendPath = "Uffd", handler.listener.Addr().String()
	}
	if err := fc.loadSnapshot(o.template.vmstate, backendType, backendPath, tapName, vsock); err != nil {
		return err
	}
	if handler != nil {
		if err := <-handler.ready; err != nil {
			return err
		}
		filled := <-handler.filled
		if filled.err != nil {
			return filled.err
		}
		if o.fill != nil {
			res.Fill = &fillReport{Pages: filled.pages, Ms: roundMs(filled.duration)}
		}
	}
	m.mark("load")

	if err := fc.setState("Resumed"); err != nil {
		return err
	}
	phase.Store(phaseResumed)
	m.mark("resume")

	if _, err := waitForAgent(vsock, waitOptions{deadline: agentDeadline, attempt: 200 * time.Millisecond, maxDelay: 5 * time.Millisecond, parked: true}); err != nil {
		return err
	}
	m.mark("parked")
	m.mark("disk")

	if _, err := fc.send(http.MethodPatch, "/drives/"+rootfsDrive, map[string]any{"drive_id": rootfsDrive, "path_on_host": disk}); err != nil {
		return err
	}
	m.mark("patch")

	seed := make([]byte, 64)
	if _, err := rand.Read(seed); err != nil {
		return err
	}
	phase.Store(phaseClaimed)
	if err := sendClaim(vsock, claim{
		ID: newImpID(), Hostname: "spike", IP: "172.31.255.2/30", GW: "172.31.255.1",
		DNS: []string{"1.1.1.1"}, MAC: "06:00:ac:1f:ff:02",
		DiskBytes: float64(diskBytes), UnixMs: float64(time.Now().UnixMilli()), Seed: seed,
	}); err != nil {
		return err
	}
	m.mark("claim")

	answer, err := waitForAgent(vsock, waitOptions{deadline: claimedDeadline, attempt: time.Second, maxDelay: 5 * time.Millisecond, parked: false})
	if err != nil {
		return err
	}
	m.mark("agent")
	phase.Store(phaseAgent)

	if _, err := fc.send(http.MethodGet, "/version", nil); err != nil {
		return err
	}
	m.mark("version")

	res.AgentVersion = answer.Version
	for _, s := range answer.BootSteps {
		res.Guest[s.Name] = s.Ms
	}
	return nil
}

func newImpID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func readMeminfo(key string) int {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return -1
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) >= 2 && fields[0] == key+":" {
			value, _ := strconv.Atoi(fields[1])
			return value
		}
	}
	return -1
}

// readFreeHugeBlocks counts the free 2 MiB blocks in /proc/buddyinfo: one
// per free block of order 9, two per order 10.
func readFreeHugeBlocks() int {
	text, err := os.ReadFile("/proc/buddyinfo")
	if err != nil {
		return -1
	}
	return countFreeHugeBlocks(string(text))
}

func countFreeHugeBlocks(buddyinfo string) int {
	total := 0
	for _, line := range strings.Split(buddyinfo, "\n") {
		fields := strings.Fields(line)
		// Node 0, zone Normal, then the free counts of orders 0 to 10
		if len(fields) < 4+11 {
			continue
		}
		for order := 9; order <= 10; order++ {
			count, _ := strconv.Atoi(fields[4+order])
			total += count << (order - 9)
		}
	}
	return total
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	return strings.Join(lines[max(0, len(lines)-n):], "\n")
}
