package proc

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"slices"
	"strconv"
	"strings"
	"syscall"

	"github.com/moby/sys/user"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
)

// The account files.
const (
	passwdPath = "/etc/passwd"
	groupPath  = "/etc/group"
)

// LookupUser resolves "", "name", "uid", "name:group" or "uid:gid" against
// the guest's /etc/passwd and /etc/group, as runc resolves docker exec -u.
// os/user would need cgo or NSS for anything beyond the files, and the
// files are all a guest image has. It returns nil credentials for root, so
// the child inherits the agent's.
//
// A user with no group given also gets every group that lists it as a
// member; an explicit group is the only group.
func LookupUser(spec string) (*syscall.Credential, string, error) {
	return LookupUserIn(fsroot.Host, spec)
}

// LookupUserIn is LookupUser against the account files of fsys, such as
// the inner container's root as the agent reaches it.
func LookupUserIn(fsys fsroot.FS, spec string) (*syscall.Credential, string, error) {
	if spec == "" || spec == "root" || spec == "0" {
		return nil, "/root", nil
	}
	userPart, groupPart, hasGroup := strings.Cut(spec, ":")
	// the library resolves an empty user as the defaults' uid, which is root,
	// and an empty group as no group given
	if userPart == "" || hasGroup && groupPart == "" {
		return nil, "", fmt.Errorf("user %q: empty user or group", spec)
	}

	passwd, err := readAccounts(fsys, passwdPath, 2, 3)
	if err != nil {
		return nil, "", err
	}
	group, err := readAccounts(fsys, groupPath, 2)
	if err != nil {
		return nil, "", err
	}

	// A uid with no passwd entry gets its own number as its gid, never the
	// library's 0.
	defaults := &user.ExecUser{Home: "/"}
	if n, err := strconv.Atoi(userPart); err == nil {
		defaults.Uid, defaults.Gid = n, n
	}
	u, err := user.GetExecUser(spec, defaults, passwd, group)
	if err != nil {
		return nil, "", fmt.Errorf("user %q: %w", spec, err)
	}

	groups := []uint32{}
	if !hasGroup {
		groups = append(groups, uint32(u.Gid))
		for _, g := range u.Sgids {
			groups = append(groups, uint32(g))
		}
		slices.Sort(groups)
		groups = slices.Compact(groups)
	}
	return &syscall.Credential{Uid: uint32(u.Uid), Gid: uint32(u.Gid), Groups: groups}, u.Home, nil
}

// readAccounts reads an account file of fsys and keeps only the lines whose
// fields at idFields are ids the kernel takes. The library reads a missing or
// malformed id as 0, which is root, and setresuid and setresgid read
// (uid_t)-1 as "leave unchanged", which keeps the agent's root. A missing file
// is a nil reader, which the library reads as no entries.
func readAccounts(fsys fsroot.FS, path string, idFields ...int) (io.Reader, error) {
	f, err := fsys.OpenFile(path, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, err
	}

	var kept bytes.Buffer
	for line := range bytes.Lines(data) {
		line = bytes.TrimSpace(line)
		fields := strings.Split(string(line), ":")
		if slices.ContainsFunc(idFields, func(i int) bool { return i >= len(fields) || !isKernelID(fields[i]) }) {
			continue
		}
		kept.Write(line)
		kept.WriteByte('\n')
	}
	return &kept, nil
}

func isKernelID(field string) bool {
	id, err := strconv.ParseUint(field, 10, 32)
	return err == nil && id != math.MaxUint32
}
