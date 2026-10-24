package session

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	"google.golang.org/protobuf/reflect/protoreflect"

	"github.com/zgeoff/impz/agent/internal/proto"
)

// A viewer that falls this far behind is dropped, so a slow host connection
// never holds up the pty and the program behind it.
const maxQueued = 2 << 20

// A host frame that races EXIT must not hit a closed socket.
const exitLinger = 2 * time.Second

// A host that stopped reading must not keep its connection, and the
// goroutines behind it, forever.
const lastWriteTimeout = 5 * time.Second

type frame struct {
	typ     proto.Type
	payload []byte
	written func()
}

type viewer struct {
	conn net.Conn
	w    *proto.Writer

	mu      sync.Mutex
	queue   []frame
	queued  int
	last    *frame
	stopped bool
	wake    chan struct{}

	done chan struct{}

	written          atomic.Uint64
	progress         chan struct{}
	lastWriteTimeout time.Duration
}

func newViewer(conn net.Conn, w *proto.Writer, lastWriteTimeout time.Duration) *viewer {
	return &viewer{conn: conn, w: w, lastWriteTimeout: lastWriteTimeout, wake: make(chan struct{}, 1), done: make(chan struct{})}
}

func (v *viewer) push(f frame) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped || v.queued+len(f.payload) > maxQueued {
		return false
	}
	v.queue = append(v.queue, f)
	v.queued += len(f.payload)
	v.signal()
	return true
}

func (v *viewer) pushMessage(typ proto.Type, m protoreflect.ProtoMessage) bool {
	return v.push(frame{typ: typ, payload: mustMarshal(m)})
}

func (v *viewer) stop(last *frame, drop bool) bool {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped {
		return false
	}
	v.stopped = true
	v.last = last
	if drop {
		for _, f := range v.queue {
			v.queued -= len(f.payload)
		}
		v.queue = nil
	}
	if last != nil && last.typ != proto.TypeExit {
		_ = v.conn.SetWriteDeadline(time.Now().Add(v.lastWriteTimeout))
	}
	v.signal()
	return true
}

func (v *viewer) signalProgress() {
	if v.progress == nil {
		return
	}
	select {
	case v.progress <- struct{}{}:
	default:
	}
}

func (v *viewer) signal() {
	select {
	case v.wake <- struct{}{}:
	default:
	}
}

func (v *viewer) run() {
	defer close(v.done)
	for {
		<-v.wake
		v.mu.Lock()
		batch, stopped, last := v.queue, v.stopped, v.last
		v.queue = nil
		v.mu.Unlock()
		for _, f := range batch {
			if v.w.Write(f.typ, f.payload) != nil {
				v.fail()
				return
			}
			if f.typ == proto.TypeStdout {
				v.written.Add(uint64(len(f.payload)))
				v.signalProgress()
			}
			v.mu.Lock()
			v.queued -= len(f.payload)
			v.mu.Unlock()
		}
		if !stopped {
			continue
		}
		v.finish(last)
		return
	}
}

func (v *viewer) fail() {
	v.mu.Lock()
	v.stopped = true
	v.mu.Unlock()
	v.conn.Close()
}

func (v *viewer) finish(last *frame) {
	if last == nil {
		return
	}
	if v.w.Write(last.typ, last.payload) != nil {
		v.conn.Close()
		return
	}
	if last.written != nil {
		last.written()
	}
	if last.typ != proto.TypeExit {
		v.conn.Close()
		return
	}
	_ = v.conn.SetReadDeadline(time.Now().Add(exitLinger))
}

func mustMarshal(m protoreflect.ProtoMessage) []byte {
	b, err := proto.Marshal(m)
	if err != nil {
		panic(err)
	}
	return b
}
