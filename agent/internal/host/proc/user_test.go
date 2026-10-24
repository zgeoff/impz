package proc

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
)

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

// The error text is the EXEC_FAILED message the host shows.
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

// The library reads a missing or malformed id as 0, and setresuid and
// setresgid read (uid_t)-1 as "leave unchanged": either would keep the
// agent's root, so a line with such an id is no entry at all.
func TestLookupUserInSkipsAnAccountLineWithAnIDTheKernelRefuses(t *testing.T) {
	for _, tc := range []struct {
		name, passwd, group, spec, want string
	}{
		{name: "malformed uid", passwd: "bad:x:abc:1000::/:/bin/sh\n", spec: "bad",
			want: `user "bad": unable to find user bad: no matching entries in passwd file`},
		{name: "missing uid", passwd: "bad:x\n", spec: "bad",
			want: `user "bad": unable to find user bad: no matching entries in passwd file`},
		{name: "negative gid", passwd: "bad:x:1000:-1::/:/bin/sh\n", spec: "bad",
			want: `user "bad": unable to find user bad: no matching entries in passwd file`},
		{name: "the no-change gid", passwd: "bad:x:1000:4294967295::/:/bin/sh\n", spec: "bad",
			want: `user "bad": unable to find user bad: no matching entries in passwd file`},
		{name: "malformed group id", passwd: "imp:x:1000:1000::/home/imp:/bin/bash\n", group: "odd:x:zz:\n", spec: "imp:odd",
			want: `user "imp:odd": unable to find group odd: no matching entries in group file`},
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

func TestLookupUserInLeavesOutAGroupLineWithAMalformedID(t *testing.T) {
	fsys := useAccounts(t, "imp:x:1000:1000::/home/imp:/bin/bash\n", "odd:x:zz:imp\nbroken\nneg:x:-5:imp\ndocker:x:999:imp\n")

	cred, _, err := LookupUserIn(fsys, "imp")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred.Groups, []uint32{999, 1000})
}

func TestLookupUserInTakesAHighIDFromTheAccountFiles(t *testing.T) {
	fsys := useAccounts(t, "high:x:3000000000:3000000000::/:/bin/sh\n", "")

	cred, _, err := LookupUserIn(fsys, "high")

	assert.NilError(t, err)
	assert.DeepEqual(t, cred, &syscall.Credential{Uid: 3000000000, Gid: 3000000000, Groups: []uint32{3000000000}})
}

func TestLookupUserInRefusesANumericSpecOutsideTheKernelsRange(t *testing.T) {
	for _, spec := range []string{"-1", "4294967295", "imp:-1", "imp:4294967295"} {
		t.Run(spec, func(t *testing.T) {
			fsys := useAccounts(t, "imp:x:1000:1000::/home/imp:/bin/bash\n", "")

			cred, _, err := LookupUserIn(fsys, spec)

			assert.Check(t, err != nil)
			assert.Check(t, cmp.Nil(cred))
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
