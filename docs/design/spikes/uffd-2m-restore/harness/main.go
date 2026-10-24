// uffd-spike builds an imp boot template the way impd does and restores it
// through Firecracker's File backend or a UFFD page handler, timing each
// restore with impd's own marks. It runs as root, on a host with /dev/kvm.
//
//	uffd-spike build   -firecracker BIN -kernel FILE -system FILE -template DIR [-huge-pages 2M]
//	uffd-spike restore -firecracker BIN -template DIR -disk FILE -work DIR [-uffd] [-fill FILE]
//	uffd-spike bench   -firecracker BIN -file-template DIR -uffd-template DIR -disk FILE -work DIR -runs N -out FILE
//	uffd-spike summary FILE
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: uffd-spike build|restore|bench|summary [flags]")
		os.Exit(2)
	}
	if err := run(os.Args[1], os.Args[2:]); err != nil {
		fmt.Fprintf(os.Stderr, "uffd-spike: %v\n", err)
		os.Exit(1)
	}
}

func run(command string, args []string) error {
	if command == "summary" {
		return runSummary(args)
	}
	if os.Getenv(netnsEnv) != "1" {
		return reexecInNetns()
	}
	if err := createTap(tapName); err != nil {
		return fmt.Errorf("tap %s: %w", tapName, err)
	}

	flags := flag.NewFlagSet(command, flag.ExitOnError)
	firecrackerBin := flags.String("firecracker", "firecracker", "the Firecracker binary")
	switch command {
	case "build":
		kernel := flags.String("kernel", "", "the guest kernel")
		system := flags.String("system", "", "the system drive")
		template := flags.String("template", "", "the template directory to write")
		vcpus := flags.Int("vcpus", 2, "vCPUs")
		memory := flags.Int("memory-mib", 2048, "guest memory")
		hugePages := flags.String("huge-pages", "", `"2M" for hugetlbfs, empty for impd's 4 KiB`)
		minUptime := flags.Duration("min-uptime", 1500*time.Millisecond, "impd's IMP_SLEEP_MIN_GUEST_UPTIME_MS")
		_ = flags.Parse(args)
		return buildTemplate(buildOptions{
			firecracker: *firecrackerBin, kernel: *kernel, system: *system,
			template: newTemplatePaths(*template), vcpus: *vcpus, memoryMiB: *memory,
			hugePages: *hugePages, minUptime: *minUptime,
		})
	case "restore":
		template := flags.String("template", "", "the template directory")
		disk := flags.String("disk", "", "the imp disk image each run copies")
		work := flags.String("work", "", "the scratch directory for the runs")
		uffd := flags.Bool("uffd", false, "restore through a UFFD handler")
		fill := flags.String("fill", "", "a working-set file to fill before the resume")
		runs := flags.Int("runs", 1, "restores")
		_ = flags.Parse(args)
		o := restoreOptions{
			label: "restore", firecracker: *firecrackerBin, template: newTemplatePaths(*template),
			disk: *disk, workDir: *work, uffd: *uffd,
		}
		if *fill != "" {
			ws, err := readWorkingSet(*fill)
			if err != nil {
				return err
			}
			o.fill = ws.Pages
		}
		encoder := json.NewEncoder(os.Stdout)
		for i := range *runs {
			res, _, err := restoreOnce(o, i)
			if err != nil {
				return err
			}
			if err := encoder.Encode(res); err != nil {
				return err
			}
		}
		return nil
	case "bench":
		fileTemplate := flags.String("file-template", "", "the 4 KiB template for File restores")
		uffdTemplate := flags.String("uffd-template", "", "the template for UFFD restores")
		disk := flags.String("disk", "", "the imp disk image each run copies")
		work := flags.String("work", "", "the scratch directory for the runs")
		runs := flags.Int("runs", 21, "restores of each mode")
		recordRuns := flags.Int("record-runs", 3, "on-demand restores that record the working set")
		out := flags.String("out", "", "the JSON lines file to append results to")
		ws := flags.String("working-set", "", "the working-set file to write")
		_ = flags.Parse(args)
		return bench(benchOptions{
			firecracker: *firecrackerBin, fileTemplate: newTemplatePaths(*fileTemplate),
			uffdTemplate: newTemplatePaths(*uffdTemplate), disk: *disk, workDir: *work,
			runs: *runs, recordRuns: *recordRuns, out: *out, workingSet: *ws,
		})
	default:
		return fmt.Errorf("unknown command %q", command)
	}
}

func runSummary(args []string) error {
	if len(args) != 1 {
		return fmt.Errorf("usage: uffd-spike summary FILE")
	}
	file, err := os.Open(args[0]) //nolint:gosec // G703: the operator names the results file to read
	if err != nil {
		return err
	}
	defer file.Close()
	summaries, err := summarise(file)
	if err != nil {
		return err
	}
	fmt.Print(formatSummary(summaries))
	return nil
}
