package proc

import (
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

	"github.com/zgeoff/impz/agent/internal/fsroot"
)

// The account files. Variables so tests can point them at fixtures.
var (
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

	passwd, closePasswd, err := openAccounts(fsys, passwdPath)
	if err != nil {
		return nil, "", err
	}
	defer closePasswd()
	group, closeGroup, err := openAccounts(fsys, groupPath)
	if err != nil {
		return nil, "", err
	}
	defer closeGroup()

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

	// The library reads a negative id as it is, and setresuid and setresgid
	// take (uid_t)-1 as "leave unchanged", which would keep the agent's root.
	ids := append([]int{u.Uid, u.Gid}, u.Sgids...)
	if i := slices.IndexFunc(ids, func(id int) bool { return id < 0 || id >= math.MaxUint32 }); i >= 0 {
		return nil, "", fmt.Errorf("user %q: id %d is out of range", spec, ids[i])
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

// openAccounts opens an account file of fsys. A missing file is a nil
// reader, which the library reads as no entries; a nil *os.File inside the
// interface would fail the read instead.
func openAccounts(fsys fsroot.FS, path string) (io.Reader, func(), error) {
	f, err := fsys.OpenFile(path, os.O_RDONLY, 0)
	if errors.Is(err, os.ErrNotExist) {
		return nil, func() {}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	return f, func() { f.Close() }, nil
}
