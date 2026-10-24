package sysutil

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func writeFile(t *testing.T, dir, name string, mode os.FileMode) string {
	t.Helper()
	p := filepath.Join(dir, name)
	assert.NilError(t, os.WriteFile(p, nil, mode))
	return p
}

func TestFindInPathTakesTheFirstExecutableAndSkipsTheRest(t *testing.T) {
	plain, dir, exec, later := t.TempDir(), t.TempDir(), t.TempDir(), t.TempDir()
	writeFile(t, plain, "tool", 0o644)
	assert.NilError(t, os.Mkdir(filepath.Join(dir, "tool"), 0o755))
	want := writeFile(t, exec, "tool", 0o755)
	writeFile(t, later, "tool", 0o755)

	got, err := FindInPath("tool", plain+":"+dir+":"+exec+":"+later, os.Stat)

	assert.NilError(t, err)
	assert.Check(t, cmp.Equal(got, want))
}

func TestFindInPathReadsAnEmptyDirAsTheCurrentOne(t *testing.T) {
	var asked []string
	stat := func(p string) (fs.FileInfo, error) {
		asked = append(asked, p)
		return nil, fs.ErrNotExist
	}

	_, err := FindInPath("tool", ":/bin", stat)

	assert.Check(t, cmp.Error(err, "tool: executable file not found in $PATH"))
	assert.Check(t, cmp.DeepEqual(asked, []string{"tool", "/bin/tool"}))
}

func TestCheckExecutableRefusesWhatIsNoFileToRun(t *testing.T) {
	for _, tc := range []struct {
		name   string
		create func(t *testing.T, dir string) string
	}{
		{name: "no execute bit", create: func(t *testing.T, dir string) string { return writeFile(t, dir, "plain", 0o644) }},
		{name: "a directory", create: func(t *testing.T, dir string) string { return dir }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := tc.create(t, t.TempDir())

			err := CheckExecutable(p, os.Stat)

			assert.Check(t, cmp.Error(err, p+": permission denied"))
		})
	}
}

func TestCheckExecutablePassesOnTheStatErrorOfAMissingFile(t *testing.T) {
	err := CheckExecutable(filepath.Join(t.TempDir(), "missing"), os.Stat)

	assert.Check(t, cmp.ErrorIs(err, fs.ErrNotExist))
}

func TestCheckExecutableAcceptsAFileWithAnExecuteBit(t *testing.T) {
	p := writeFile(t, t.TempDir(), "tool", 0o700)

	assert.NilError(t, CheckExecutable(p, os.Stat))
}
