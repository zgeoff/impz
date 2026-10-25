package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"
)

type benchOptions struct {
	firecracker  string
	fileTemplate templatePaths
	uffdTemplate templatePaths
	disk         string
	workDir      string
	runs         int
	recordRuns   int
	out          string
	workingSet   string
}

// bench warms the page cache with a File restore, records the working set
// over on-demand UFFD restores, then runs the three modes round-robin, so
// each mode sees the same host in the same minutes.
func bench(o benchOptions) error {
	out, err := os.OpenFile(o.out, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	encoder := json.NewEncoder(out)

	file := restoreOptions{label: "file", firecracker: o.firecracker, template: o.fileTemplate, disk: o.disk, workDir: o.workDir}
	demand := restoreOptions{label: "uffd-demand", firecracker: o.firecracker, template: o.uffdTemplate, disk: o.disk, workDir: o.workDir, uffd: true}

	warm := file
	warm.label = "warm-file"
	if res, _, err := restoreOnce(warm, 0); err != nil {
		return err
	} else if err := encoder.Encode(res); err != nil {
		return err
	}

	var ws workingSet
	record := demand
	record.label = "record-demand"
	for run := range o.recordRuns {
		res, pages, err := restoreOnce(record, run)
		if err != nil {
			return err
		}
		ws.add(int64(res.Faults.PageSize), pages)
		if err := encoder.Encode(res); err != nil {
			return err
		}
	}
	if err := ws.write(o.workingSet); err != nil {
		return err
	}

	data, err := readDataPages(o.uffdTemplate.mem, ws.PageSize)
	if err != nil {
		return err
	}
	fill := demand
	fill.label = "uffd-fill"
	fill.fill = unionPages(data, ws.Pages)
	fmt.Fprintf(os.Stderr, "fill: %d pages of %d bytes: %d with data, %d in the working set\n",
		len(fill.fill), ws.PageSize, len(data), len(ws.Pages))

	for run := range o.runs {
		for _, mode := range []restoreOptions{file, demand, fill} {
			res, _, err := restoreOnce(mode, run)
			if err != nil {
				return err
			}
			if err := encoder.Encode(res); err != nil {
				return err
			}
			fmt.Fprintf(os.Stderr, "%s %d: agent=%.1fms\n", mode.label, run, res.Marks["agent"])
		}
	}
	return nil
}

func unionPages(a, b []int64) []int64 {
	pages := slices.Concat(a, b)
	slices.Sort(pages)
	return slices.Compact(pages)
}

func median(values []float64) float64 {
	sorted := slices.Sorted(slices.Values(values))
	middle := len(sorted) / 2
	if len(sorted)%2 == 1 {
		return sorted[middle]
	}
	return (sorted[middle-1] + sorted[middle]) / 2
}

type modeSummary struct {
	Label  string
	Runs   int
	Marks  map[string]float64
	Faults map[string]float64
	FillMs float64
	Surp   float64
}

// summarise gives each mode's medians over its runs, in the order the modes
// first appear.
func summarise(results io.Reader) ([]modeSummary, error) {
	byLabel := map[string][]result{}
	var labels []string
	scanner := bufio.NewScanner(results)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var res result
		if err := json.Unmarshal(scanner.Bytes(), &res); err != nil {
			return nil, err
		}
		if _, ok := byLabel[res.Label]; !ok {
			labels = append(labels, res.Label)
		}
		byLabel[res.Label] = append(byLabel[res.Label], res)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	summaries := make([]modeSummary, 0, len(labels))
	for _, label := range labels {
		runs := byLabel[label]
		s := modeSummary{Label: label, Runs: len(runs)}
		s.Marks = medianOf(runs, func(r result) map[string]float64 { return r.Marks })
		s.Faults = medianOf(runs, func(r result) map[string]float64 {
			if r.Faults == nil {
				return nil
			}
			values := map[string]float64{"service_p50_us": r.Faults.ServiceP50Us, "service_sum_ms": r.Faults.ServiceSumMs}
			for phase, count := range r.Faults.ByPhase {
				values[phase] = float64(count)
			}
			return values
		})
		fills := []float64{}
		surps := []float64{}
		for _, r := range runs {
			if r.Fill != nil {
				fills = append(fills, r.Fill.Ms)
			}
			surps = append(surps, float64(r.HugePagesSurp))
		}
		if len(fills) > 0 {
			s.FillMs = median(fills)
		}
		s.Surp = median(surps)
		summaries = append(summaries, s)
	}
	return summaries, nil
}

func medianOf(runs []result, pick func(result) map[string]float64) map[string]float64 {
	values := map[string][]float64{}
	for _, r := range runs {
		for key, value := range pick(r) {
			values[key] = append(values[key], value)
		}
	}
	medians := make(map[string]float64, len(values))
	for key, list := range values {
		medians[key] = median(list)
	}
	return medians
}

var markOrder = []string{"spawn", "load", "resume", "parked", "disk", "patch", "claim", "agent", "version"}

func formatSummary(summaries []modeSummary) string {
	var b strings.Builder
	b.WriteString("| mode | runs | " + strings.Join(markOrder, " | ") + " | faults load/resumed/claimed | fill ms |\n")
	b.WriteString("|" + strings.Repeat(" --- |", len(markOrder)+4) + "\n")
	for _, s := range summaries {
		fmt.Fprintf(&b, "| %s | %d |", s.Label, s.Runs)
		for _, name := range markOrder {
			fmt.Fprintf(&b, " %.1f |", s.Marks[name])
		}
		if len(s.Faults) == 0 {
			b.WriteString(" | |\n")
			continue
		}
		fmt.Fprintf(&b, " %.0f/%.0f/%.0f | %.1f |\n", s.Faults["load"], s.Faults["resumed"], s.Faults["claimed"], s.FillMs)
	}
	return b.String()
}
