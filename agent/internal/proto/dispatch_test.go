package proto

import (
	"bytes"
	"fmt"
	"io"
	"syscall"
	"testing"

	"gotest.tools/v3/assert"
)

func recordingInput(calls *[]string) Input {
	return Input{
		Stdin:    func(p []byte) { *calls = append(*calls, "stdin "+string(p)) },
		StdinEOF: func() { *calls = append(*calls, "stdin eof") },
		Resize:   func(cols, rows uint16) { *calls = append(*calls, fmt.Sprintf("resize %dx%d", cols, rows)) },
		Signal:   func(sig syscall.Signal) { *calls = append(*calls, fmt.Sprintf("signal %d", sig)) },
		Other:    func(t Type) { *calls = append(*calls, "other "+t.String()) },
	}
}

func TestDispatchHandsEachFrameToItsHandlerInOrderUntilTheHostCloses(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	assert.NilError(t, w.Write(TypeStdin, []byte("ls\n")))
	assert.NilError(t, w.WriteMessage(TypeResize, &Resize{Cols: 120, Rows: 40}))
	assert.NilError(t, w.WriteMessage(TypeSignal, &Signal{Signal: 15}))
	assert.NilError(t, w.Write(TypeStdinEOF, nil))
	assert.NilError(t, w.Write(TypeRequest, []byte(`{"op":"ping"}`)))
	var calls []string

	err := Dispatch(NewReader(&buf), recordingInput(&calls))

	assert.ErrorIs(t, err, io.EOF)
	assert.DeepEqual(t, calls, []string{"stdin ls\n", "resize 120x40", "signal 15", "stdin eof", "other " + TypeRequest.String()})
}

func TestDispatchDropsAResizeOrSignalThatDoesNotParse(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	assert.NilError(t, w.Write(TypeResize, []byte("not json")))
	assert.NilError(t, w.Write(TypeSignal, []byte(`{"signal":"TERM"}`)))
	var calls []string

	err := Dispatch(NewReader(&buf), recordingInput(&calls))

	assert.ErrorIs(t, err, io.EOF)
	assert.DeepEqual(t, calls, []string(nil))
}

func TestDispatchDropsASignalThatNamesNoSignal(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	assert.NilError(t, w.WriteMessage(TypeSignal, &Signal{Signal: 0}))
	assert.NilError(t, w.WriteMessage(TypeSignal, &Signal{Signal: -9}))
	var calls []string

	err := Dispatch(NewReader(&buf), recordingInput(&calls))

	assert.ErrorIs(t, err, io.EOF)
	assert.DeepEqual(t, calls, []string(nil))
}

func TestDispatchIgnoresAFrameWhoseHandlerIsNil(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	assert.NilError(t, w.Write(TypeStdinEOF, nil))
	assert.NilError(t, w.Write(TypeStdin, []byte("x")))
	var calls []string
	in := recordingInput(&calls)
	in.StdinEOF = nil

	err := Dispatch(NewReader(&buf), in)

	assert.ErrorIs(t, err, io.EOF)
	assert.DeepEqual(t, calls, []string{"stdin x"})
}

func TestDispatchReturnsTheErrorOfAFailedRead(t *testing.T) {
	var calls []string

	err := Dispatch(NewReader(bytes.NewReader([]byte{byte(TypeStdin), 0, 0, 0, 9, 'l', 's'})), recordingInput(&calls))

	assert.ErrorIs(t, err, io.ErrUnexpectedEOF)
	assert.DeepEqual(t, calls, []string(nil))
}
