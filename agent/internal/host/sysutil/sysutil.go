// Package sysutil holds the small system helpers that several of the agent's
// packages share: random names, the fds a unix socket passes, and the
// search of a PATH.
package sysutil

import (
	"crypto/rand"
	"encoding/hex"

	"golang.org/x/sys/unix"
)

// RandomHex returns n random bytes as 2n lowercase hex digits.
func RandomHex(n int) string {
	b := make([]byte, n)
	// crypto/rand.Read never fails: the runtime crashes first
	rand.Read(b)
	return hex.EncodeToString(b)
}

// NewUUID returns the 16 bytes of a random version 4 UUID.
func NewUUID() [16]byte {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return b
}

// ParseRights returns every fd that the SCM_RIGHTS messages in oob carry. A
// message it cannot parse adds none.
func ParseRights(oob []byte) []int {
	msgs, err := unix.ParseSocketControlMessage(oob)
	if err != nil {
		return nil
	}
	var fds []int
	for _, m := range msgs {
		if got, err := unix.ParseUnixRights(&m); err == nil {
			fds = append(fds, got...)
		}
	}
	return fds
}

// CloseFds closes each of fds.
func CloseFds(fds []int) {
	for _, fd := range fds {
		unix.Close(fd)
	}
}
