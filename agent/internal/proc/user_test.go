package proc

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/fsroot"
)

// useAccounts is a root whose /etc/passwd and /etc/group hold the given
// contents. An empty group leaves /etc/group out.
func useAccounts(t *testing.T, passwd, group string) fsroot.FS {
	t.Helper()
	dir := t.TempDir()
	assert.NilError(t, os.Mkdir(filepath.Join(dir, "etc"), 0o755))
	assert.NilError(t, os.WriteFile(filepath.Join(dir, passwdPath), []byte(passwd), 0o644))
	if group != "" {
		assert.NilError(t, os.WriteFile(filepath.Join(dir, groupPath), []byte(group), 0o644))
	}
	root, err := fsroot.Open(dir)
	assert.NilError(t, err)
	t.Cleanup(func() { root.Close() })
	return root
}

func TestLookupUserInResolvesTheCredentialsAndHomeOfASpec(t *testing.T) {
	// imp is in docker and wheel, svc only in docker
	const passwd = "root:x:0:0:root:/root:/bin/sh\n" +
		"imp:x:1000:1000::/home/imp:/bin/bash\n" +
		"svc:x:1001:1001::/srv:/bin/sh\n"
	const group = "root:x:0:\n" +
		"docker:x:999:imp,svc\n" +
		"imp:x:1000:\n" +
		"svc:x:1001:\n" +
		"wheel:x:10:other,imp\n" +
		"staff:x:50:\n"
	for _, tc := range []struct {
		spec string
		cred *syscall.Credential
		home string
	}{
		{"imp", &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{10, 999, 1000}}, "/home/imp"},
		{"1000", &syscall.Credential{Uid: 1000, Gid: 1000, Groups: []uint32{10, 999, 1000}}, "/home/imp"},
		// An explicit group is the only group, as in runc.
		{"imp:staff", &syscall.Credential{Uid: 1000, Gid: 50, Groups: []uint32{}}, "/home/imp"},
		{"imp:7", &syscall.Credential{Uid: 1000, Gid: 7, Groups: []uint32{}}, "/home/imp"},
		{"svc", &syscall.Credential{Uid: 1001, Gid: 1001, Groups: []uint32{999, 1001}}, "/srv"},
		// A uid with no passwd entry takes its own number as its gid.
		{"4242", &syscall.Credential{Uid: 4242, Gid: 4242, Groups: []uint32{4242}}, "/"},
		{"4242:999", &syscall.Credential{Uid: 4242, Gid: 999, Groups: []uint32{}}, "/"},
	} {
		t.Run(tc.spec, func(t *testing.T) {
			fsys := useAccounts(t, passwd, group)

			cred, home, err := LookupUserIn(fsys, tc.spec)

			assert.NilError(t, err)
			assert.Check(t, cmp.DeepEqual(cred, tc.cred))
			assert.Check(t, cmp.Equal(home, tc.home))
		})
	}
}

func TestLookupUserInLeavesRootToInheritTheAgentsCredentials(t *testing.T) {
	for _, spec := range []string{"", "root", "0"} {
		t.Run("spec "+spec, func(t *testing.T) {
			fsys := useAccounts(t, "root:x:0:0:root:/root:/bin/sh\n", "root:x:0:\n")

			cred, home, err := LookupUserIn(fsys, spec)

			assert.NilError(t, err)
			assert.Check(t, cmp.Nil(cred))
			assert.Check(t, cmp.Equal(home, "/root"))
		})
	}
}

// The error text is the EXEC_FAILED message the host shows. A failed lookup
// gives no credential and no home, so it never falls back to root.
func TestLookupUserInFailsForASpecItCannotResolve(t *testing.T) {
	for _, tc := range []struct {
		name, spec, want string
	}{
		{name: "unknown user", spec: "nobody",
			want: `user "nobody": unable to find user nobody: no matching entries in passwd file`},
		{name: "unknown group", spec: "imp:nogroup",
			want: `user "imp:nogroup": unable to find group nogroup: no matching entries in group file`},
		// The library would read an empty user as uid 0.
		{name: "empty user", spec: ":imp", want: `user ":imp": empty user or group`},
		{name: "empty group", spec: "imp:", want: `user "imp:": empty user or group`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fsys := useAccounts(t, "imp:x:1000:1000::/home/imp:/bin/bash\n", "imp:x:1000:\n")

			cred, home, err := LookupUserIn(fsys, tc.spec)

			assert.Check(t, cmp.Error(err, tc.want))
			assert.Check(t, cmp.Nil(cred))
			assert.Check(t, cmp.Equal(home, ""))
		})
	}
}

// setresuid and setresgid read (uid_t)-1 as "leave unchanged", so an id
// outside 0 to 2^32-2 would keep the agent's root.
func TestLookupUserInRejectsAnIDOutsideTheKernelsRange(t *testing.T) {
	for _, tc := range []struct {
		name, passwd, group, spec, want string
	}{
		{name: "negative uid", passwd: "neg:x:-1:1000::/:/bin/sh\n", group: "", spec: "neg",
			want: `user "neg": id -1 is out of range`},
		{name: "negative gid", passwd: "neg:x:1000:-1::/:/bin/sh\n", group: "", spec: "neg",
			want: `user "neg": id -1 is out of range`},
		{name: "negative supplementary gid", passwd: "imp:x:1000:1000::/home/imp:/bin/bash\n", group: "odd:x:-5:imp\n", spec: "imp",
			want: `user "imp": id -5 is out of range`},
		{name: "the no-change gid", passwd: "big:x:1000:4294967295::/:/bin/sh\n", group: "", spec: "big",
			want: `user "big": id 4294967295 is out of range`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fsys := useAccounts(t, tc.passwd, tc.group)

			cred, home, err := LookupUserIn(fsys, tc.spec)

			assert.Check(t, cmp.Error(err, tc.want))
			assert.Check(t, cmp.Nil(cred))
			assert.Check(t, cmp.Equal(home, ""))
		})
	}
}

func TestLookupUserInGivesOnlyThePrimaryGroupWithoutAGroupFile(t *testing.T) {
	fsys := useAccounts(t, "imp:x:1000:1000::/home/imp:/bin/bash\n", "")

	cred, _, err := LookupUserIn(fsys, "imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{1000})
}

func TestLookupUserInReadsAGroupLineLongerThanTheScannerDefault(t *testing.T) {
	members := strings.Repeat("someone,", 20000) + "imp"
	fsys := useAccounts(t, "imp:x:1000:1000::/home/imp:/bin/bash\n", "big:x:4000:"+members+"\n")

	cred, _, err := LookupUserIn(fsys, "imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{1000, 4000})
}
