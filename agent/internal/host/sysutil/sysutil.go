package sysutil

import (
	"crypto/rand"
	"encoding/hex"

	"golang.org/x/sys/unix"
)

func RandomHex(n int) string {
	b := make([]byte, n)
	// crypto/rand.Read never fails: the runtime crashes first
	rand.Read(b)
	return hex.EncodeToString(b)
}

func NewUUID() [16]byte {
	var b [16]byte
	rand.Read(b[:])
	// the version 4 and variant bits of a random UUID
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return b
}

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

func CloseFds(fds []int) {
	for _, fd := range fds {
		unix.Close(fd)
	}
}
