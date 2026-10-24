package server

import (
	"io"
	"log"
	"testing"

	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"

	"github.com/zgeoff/impz/agent/internal/proto"
)

func quietLog(t *testing.T) {
	t.Helper()
	prev := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(prev) })
}

// The agent is PID 1, so a panic in a unary request must cost one request,
// not the process.
func TestHandleRepliesInternalToAUnaryRequestThatPanics(t *testing.T) {
	quietLog(t)

	resp := roundTrip(t, &Server{}, &proto.Request{Op: proto.OpServicesList})

	assert.Equal(t, errorCode(t, resp), proto.ErrInternal)
}

func TestHandleClosesTheConnectionOfAStreamRequestThatPanics(t *testing.T) {
	quietLog(t)

	resp := roundTrip(t, &Server{}, &proto.Request{Op: proto.OpExec, Argv: []string{"true"}})

	assert.Check(t, cmp.Nil(resp), "exec reply %s, want a closed connection", resp)
}
