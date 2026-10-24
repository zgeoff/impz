package main

import (
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
)

const childEnv = "KSM_EXEC_TEST_CHILD"

func TestMain(m *testing.M) {
	if os.Getenv(childEnv) == "1" {
		flag, err := unix.PrctlRetInt(unix.PR_GET_MEMORY_MERGE, 0, 0, 0, 0)
		if err != nil {
			os.Stdout.WriteString("error " + err.Error())
			os.Exit(1)
		}
		os.Stdout.WriteString(strconv.Itoa(flag))
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func kernelAtLeast(t *testing.T, major, minor int) bool {
	t.Helper()
	var uts unix.Utsname
	assert.NilError(t, unix.Uname(&uts))
	return releaseAtLeast(unix.ByteSliceToString(uts.Release[:]), major, minor)
}

// A release can read like "6.6.87.2-microsoft-standard-WSL2".
func releaseAtLeast(release string, major, minor int) bool {
	parts := strings.SplitN(release, ".", 3)
	gotMajor, _ := strconv.Atoi(parts[0])
	gotMinor := 0
	if len(parts) > 1 {
		// the leading digits: "7-rc1" is 7
		rest := strings.TrimLeft(parts[1], "0123456789")
		gotMinor, _ = strconv.Atoi(parts[1][:len(parts[1])-len(rest)])
	}

	return gotMajor > major || (gotMajor == major && gotMinor >= minor)
}

func buildKsmExec(t *testing.T) (bin, self string) {
	t.Helper()

	if !kernelAtLeast(t, 6, 7) {
		t.Skip("the merge flag survives exec from Linux 6.7")
	}
	if _, err := os.Stat("/sys/kernel/mm/ksm"); err != nil {
		t.Skip("this kernel has no KSM")
	}

	bin = filepath.Join(t.TempDir(), "ksm-exec")
	out, err := exec.Command("go", "build", "-o", bin, ".").CombinedOutput()
	assert.NilError(t, err, "go build: %s", out)

	self, err = os.Executable()
	assert.NilError(t, err)

	return bin, self
}

func TestKsmExecRunsTheProgramWithTheMergeFlagSet(t *testing.T) {
	bin, self := buildKsmExec(t)
	child := exec.Command(bin, self)
	child.Env = append(os.Environ(), childEnv+"=1")

	out, err := child.Output()

	assert.NilError(t, err, "ksm-exec: %s", out)
	assert.Equal(t, string(out), "1", "the child's PR_GET_MEMORY_MERGE")
}

// The jailer execs Firecracker in turn: the flag must outlive a second exec.
func TestKsmExecKeepsTheMergeFlagAcrossASecondExecAsTheJailers(t *testing.T) {
	bin, self := buildKsmExec(t)
	// sh stands in for the jailer: it execs the next program in place
	child := exec.Command(bin, "sh", "-c", `exec "$0"`, self)
	child.Env = append(os.Environ(), childEnv+"=1")

	out, err := child.Output()

	assert.NilError(t, err, "ksm-exec: %s", out)
	assert.Equal(t, string(out), "1", "the child's PR_GET_MEMORY_MERGE after two execs")
}

func TestReleaseAtLeastComparesMajorThenMinor(t *testing.T) {
	for _, tc := range []struct {
		release string
		want    bool
	}{
		{release: "6.7.0", want: true},
		{release: "6.10.2-arch1-1", want: true},
		{release: "7.0", want: true},
		{release: "6.6.87.2-microsoft-standard-WSL2", want: false},
		{release: "5.15.0-91-generic", want: false},
		{release: "6.7-rc1", want: true},
		{release: "6", want: false},
	} {
		t.Run(tc.release, func(t *testing.T) {
			assert.Equal(t, releaseAtLeast(tc.release, 6, 7), tc.want)
		})
	}
}

// The merge flag is set on this test process before the exec fails, so the
// test puts it back as it found it.
func TestRunMergedFailsForAMissingProgram(t *testing.T) {
	// PR_GET_MEMORY_MERGE is EINVAL on a kernel without the prctl (before
	// Linux 6.4, or without CONFIG_KSM), where the call fails before it looks
	// at the program.
	prev, err := unix.PrctlRetInt(unix.PR_GET_MEMORY_MERGE, 0, 0, 0, 0)
	if errors.Is(err, unix.EINVAL) {
		t.Skip("this kernel has no PR_SET_MEMORY_MERGE")
	}
	assert.NilError(t, err)
	t.Cleanup(func() { unix.Prctl(unix.PR_SET_MEMORY_MERGE, uintptr(prev), 0, 0, 0) })

	err = runMerged([]string{"/nonexistent/program"})

	assert.ErrorIs(t, err, fs.ErrNotExist)
}

func TestRunMergedNamesTheMissingKernelFeature(t *testing.T) {
	_, err := unix.PrctlRetInt(unix.PR_GET_MEMORY_MERGE, 0, 0, 0, 0)
	if !errors.Is(err, unix.EINVAL) {
		t.Skip("this kernel has PR_SET_MEMORY_MERGE")
	}

	err = runMerged([]string{"/nonexistent/program"})

	assert.ErrorIs(t, err, unix.EINVAL)
	assert.ErrorContains(t, err, "needs CONFIG_KSM")
}
