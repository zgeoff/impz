package sysutil

import (
	"testing"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

func TestRandomHexIsFreshLowercaseHexOfTwiceTheLength(t *testing.T) {
	a := RandomHex(8)
	b := RandomHex(8)

	assert.Check(t, cmp.Regexp(`^[0-9a-f]{16}$`, a))
	assert.Check(t, a != b, "two names are both %q", a)
}

func TestNewUUIDSetsTheVersion4AndVariantBits(t *testing.T) {
	a := NewUUID()
	b := NewUUID()

	assert.Check(t, cmp.Equal(a[6]&0xf0, byte(0x40)))
	assert.Check(t, cmp.Equal(a[8]&0xc0, byte(0x80)))
	assert.Check(t, a != b, "two ids are both %x", a)
}

// socketpair returns a connected unix pair that the test closes.
func socketpair(t *testing.T) [2]int {
	t.Helper()
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)
	t.Cleanup(func() { CloseFds(pair[:]) })
	return pair
}

func TestParseRightsReturnsTheFdsAMessageCarried(t *testing.T) {
	pair := socketpair(t)
	sent := socketpair(t)
	assert.NilError(t, unix.Sendmsg(pair[0], []byte{0}, unix.UnixRights(sent[0], sent[1]), nil, 0))
	oob := make([]byte, unix.CmsgSpace(2*4))
	_, oobn, _, _, err := unix.Recvmsg(pair[1], make([]byte, 1), oob, unix.MSG_CMSG_CLOEXEC)
	assert.NilError(t, err)

	fds := ParseRights(oob[:oobn])
	t.Cleanup(func() { CloseFds(fds) })

	assert.Assert(t, cmp.Len(fds, 2))
	for _, fd := range fds {
		typ, err := unix.GetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_TYPE)
		assert.Check(t, err)
		assert.Check(t, cmp.Equal(typ, unix.SOCK_SEQPACKET))
	}
}

func TestParseRightsReturnsNoFdsForAMalformedMessage(t *testing.T) {
	assert.Check(t, cmp.Len(ParseRights([]byte{1, 2, 3}), 0))
}

func TestCloseFdsClosesEveryFd(t *testing.T) {
	pair, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	assert.NilError(t, err)

	CloseFds(pair[:])

	for _, fd := range pair {
		_, err := unix.FcntlInt(uintptr(fd), unix.F_GETFD, 0)
		assert.Check(t, cmp.ErrorIs(err, unix.EBADF))
	}
}
