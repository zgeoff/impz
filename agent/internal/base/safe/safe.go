package safe

import (
	"log"
	"runtime/debug"
)

// The agent is PID 1: if it dies, the kernel panics and the imp is gone.
func Go(name string, f func(), onPanic func()) {
	go func() {
		defer Recover(name, onPanic)
		f()
	}()
}

func Call(name string, f func()) {
	defer Recover(name, nil)
	f()
}

// Recover must be deferred directly: recover only works in the deferred call.
func Recover(name string, onPanic func()) {
	v := recover()
	if v == nil {
		return
	}
	log.Printf("%s: panic: %v\n%s", name, v, debug.Stack())
	if onPanic != nil {
		Call(name+" cleanup", onPanic)
	}
}
