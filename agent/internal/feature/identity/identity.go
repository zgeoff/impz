package identity

import (
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/sysutil"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const keygenTimeout = 30 * time.Second

const stagePrefix = ".imp-hostkeys-"

type keygenFunc func(prefix string) error

// impd keeps asking, through imp.reset_identity=1, until a boot reports ok.
// See docs/guides/templates.md#identity.
func Reset(runner proc.Runner, root fsroot.FS, env []string) string {
	var keygen keygenFunc
	if path, err := lookPathIn(root, "ssh-keygen", env); err == nil {
		keygen = func(prefix string) error { return runKeygen(runner, path, prefix, env) }
	}
	err := resetIdentityAt(root, keygen)
	// the new files must outlive a crash: impd stops asking after this boot
	unix.Sync()
	if err != nil {
		log.Printf("identity: %v", err)
		return proto.IdentityResetFailed
	}
	return proto.IdentityResetOK
}

func resetIdentityAt(root fsroot.FS, keygen keygenFunc) error {
	return errors.Join(writeMachineID(root, newMachineID()), resetHostKeys(root, keygen))
}

// a random v4 UUID as 32 lowercase hex digits, as systemd-machine-id-setup
// writes one
func newMachineID() string {
	id := sysutil.NewUUID()
	return hex.EncodeToString(id[:])
}

// D-Bus keeps its own copy unless it is a link. An empty or missing file
// stays as it is: the template holds no id to share.
func writeMachineID(root fsroot.FS, id string) error {
	for _, p := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		fi, err := root.Lstat(p)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !fi.Mode().IsRegular() || fi.Size() == 0 {
			continue
		}
		if err := fsroot.WriteFileAtomic(root, p, []byte(id+"\n"), fi.Mode().Perm()); err != nil {
			return fmt.Errorf("%s: %w", p, err)
		}
	}
	return nil
}

// A keygen that fails or times out leaves the old keys, so sshd still starts.
func resetHostKeys(root fsroot.FS, keygen keygenFunc) error {
	const dir = "/etc/ssh"
	// a container that is down fails here, not as a missing ssh-keygen
	if _, err := root.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	removeStaleStages(root, dir)
	if keygen == nil {
		log.Printf("identity: no ssh-keygen; ssh host keys kept")
		return nil
	}
	stage := filepath.Join(dir, stagePrefix+sysutil.RandomHex(8))
	made := filepath.Join(stage, "etc/ssh")
	if err := root.MkdirAll(made, 0o755); err != nil {
		return err
	}
	if err := keygen(stage); err != nil {
		// a keygen that timed out may still write here: the next boot drops it
		return fmt.Errorf("ssh-keygen -A: %w", err)
	}
	defer func() { _ = root.RemoveAll(stage) }()
	keys, err := listHostKeys(root, made)
	if err != nil {
		return err
	}
	if len(keys) == 0 {
		return errors.New("ssh-keygen -A made no host keys")
	}
	kept := make(map[string]bool, len(keys))
	for _, name := range keys {
		if err := root.Rename(filepath.Join(made, name), filepath.Join(dir, name)); err != nil {
			return err
		}
		kept[name] = true
	}
	old, err := listHostKeys(root, dir)
	if err != nil {
		return err
	}
	for _, name := range old {
		if kept[name] {
			continue
		}
		if err := root.Remove(filepath.Join(dir, name)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

func listHostKeys(root fsroot.FS, dir string) ([]string, error) {
	entries, err := root.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var keys []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "ssh_host_") {
			keys = append(keys, e.Name())
		}
	}
	return keys, nil
}

func removeStaleStages(root fsroot.FS, dir string) {
	entries, _ := root.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), stagePrefix) {
			_ = root.RemoveAll(filepath.Join(dir, e.Name()))
		}
	}
}

// A relative dir in PATH names nothing inside the container's root.
func lookPathIn(root fsroot.FS, file string, env []string) (string, error) {
	return sysutil.FindInPath(file, proc.Get(env, "PATH"), func(p string) (fs.FileInfo, error) {
		if !filepath.IsAbs(p) {
			return nil, fs.ErrNotExist
		}
		fi, err := root.Stat(p)
		if err == nil && !fi.Mode().IsRegular() {
			return nil, fmt.Errorf("%s: not a regular file", p)
		}
		return fi, err
	})
}

// ssh-keygen -A -f prefix writes every missing default host key under
// prefix/etc/ssh.
func runKeygen(runner proc.Runner, path, prefix string, env []string) error {
	p, err := runner.Start(proc.Spec{
		Argv:  []string{path, "-A", "-f", prefix},
		Env:   env,
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	})
	if err != nil {
		return err
	}
	select {
	case st := <-p.Done:
		if st.Code != 0 {
			return fmt.Errorf("exit %d, signal %d", st.Code, st.Signal)
		}
		return nil
	case <-time.After(keygenTimeout):
		return fmt.Errorf("still running after %s", keygenTimeout)
	}
}
