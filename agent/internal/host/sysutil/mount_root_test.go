//go:build root

// The tests that mount, so they need root: run them with -tags root as root.

package sysutil

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestMountOnceMountsAnEmptyTarget(t *testing.T) {
	target := t.TempDir()

	err := MountOnce("tmpfs", target, "tmpfs", 0, "size=64k")

	assert.NilError(t, err)
	t.Cleanup(func() { unix.Unmount(target, unix.MNT_DETACH) })
	assert.Check(t, Mounted(target))
}

func TestMountOnceLeavesAMountedTargetAlone(t *testing.T) {
	target := t.TempDir()
	assert.NilError(t, unix.Mount("tmpfs", target, "tmpfs", 0, "size=64k"))
	t.Cleanup(func() { unix.Unmount(target, unix.MNT_DETACH) })
	assert.NilError(t, os.WriteFile(filepath.Join(target, "marker"), []byte("first"), 0o644))

	err := MountOnce("tmpfs", target, "tmpfs", 0, "size=64k")

	assert.NilError(t, err)
	b, err := os.ReadFile(filepath.Join(target, "marker"))
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(string(b), "first"))
	info, err := os.ReadFile("/proc/self/mountinfo")
	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(strings.Count(string(info), " "+target+" "), 1))
}
