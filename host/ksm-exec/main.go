package main

import (
	"fmt"
	"os"
	"os/exec"

	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ksm-exec PROGRAM [ARG...]")
		os.Exit(2)
	}

	err := runMerged(os.Args[1:])
	fmt.Fprintf(os.Stderr, "ksm-exec: %v\n", err)
	os.Exit(1)
}

// Firecracker's seccomp filter traps prctl, so the flag is set here. Linux
// 6.10 or later keeps it across each exec, the jailer's into Firecracker too.
func runMerged(argv []string) error {
	if err := unix.Prctl(unix.PR_SET_MEMORY_MERGE, 1, 0, 0, 0); err != nil {
		return fmt.Errorf("prctl PR_SET_MEMORY_MERGE (needs CONFIG_KSM): %w", err)
	}

	path, err := exec.LookPath(argv[0])
	if err != nil {
		return err
	}

	return unix.Exec(path, argv, os.Environ())
}
