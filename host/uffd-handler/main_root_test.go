//go:build root

// The tests that drop the handler's privileges, so they need root: run them
// with -tags root as root.

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/poll"
)

func TestTheHandlerServesAsTheUserItIsGiven(t *testing.T) {
	// a socket path has a 108-byte limit, which a TMPDIR can pass
	dir := t.TempDir()
	t.Chdir(dir)
	self, err := os.Executable()
	assert.NilError(t, err)
	cmd := exec.Command(self, "--socket", "uffd.sock", "--uid", "65534", "--gid", "65534")
	cmd.Env = append(os.Environ(), handlerModeEnv+"=1")
	cmd.ExtraFiles = []*os.File{writeMemFile(t, dir)}
	assert.NilError(t, cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		if _, err := os.Stat("uffd.sock"); err == nil {
			return poll.Success()
		}
		return poll.Continue("the handler's socket is not in place")
	})

	// the socket appears before the drop, so wait for the drop itself
	status := map[string]string{}
	poll.WaitOn(t, func(poll.LogT) poll.Result {
		raw, err := os.ReadFile("/proc/" + strconv.Itoa(cmd.Process.Pid) + "/status")
		if err != nil {
			return poll.Error(err)
		}
		for _, line := range strings.Split(string(raw), "\n") {
			key, value, _ := strings.Cut(line, ":")
			status[key] = strings.TrimSpace(value)
		}
		if status["NoNewPrivs"] != "1" {
			return poll.Continue("the handler has not dropped its privileges")
		}
		return poll.Success()
	})

	assert.Equal(t, status["Uid"], "65534\t65534\t65534\t65534")
	assert.Equal(t, status["Gid"], "65534\t65534\t65534\t65534")
	assert.Equal(t, status["Groups"], "")
	assert.Equal(t, status["CapEff"], "0000000000000000")
	assert.Equal(t, status["CapPrm"], "0000000000000000")
}
