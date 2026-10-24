package proto

import (
	"bufio"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// The numbers are part of the wire format that impd reads.
type Type uint8

const (
	TypeRequest    Type = 1  // host→guest, JSON Request; always the first frame
	TypeResponse   Type = 2  // guest→host, JSON; the reply to a unary request or a failed exec
	TypeStdin      Type = 3  // host→guest, raw bytes
	TypeStdinEOF   Type = 4  // host→guest, empty
	TypeResize     Type = 5  // host→guest, JSON Resize
	TypeSignal     Type = 6  // host→guest, JSON Signal
	TypeStarted    Type = 7  // guest→host, JSON Started
	TypeStdout     Type = 8  // guest→host, raw bytes
	TypeStderr     Type = 9  // guest→host, raw bytes
	TypeExit       Type = 10 // guest→host, JSON Exit; the last frame
	TypeDetached   Type = 11 // guest→host, JSON Detached; the last frame of a session connection
	TypeStdoutEOF  Type = 12 // guest→host, empty; a dial target closed its side
	TypeConnection Type = 13 // guest→host, JSON Connection; a client connected to an agent.listen socket
	TypeCursor     Type = 14 // guest→host, JSON LogCursor; how far a services.logs stream has sent
)

func (t Type) String() string {
	names := [...]string{"", "REQUEST", "RESPONSE", "STDIN", "STDIN_EOF", "RESIZE",
		"SIGNAL", "STARTED", "STDOUT", "STDERR", "EXIT", "DETACHED", "STDOUT_EOF", "CONNECTION",
		"CURSOR"}
	if int(t) < len(names) && names[t] != "" {
		return names[t]
	}
	return fmt.Sprintf("Type(%d)", uint8(t))
}

const MaxPayload = 1 << 20

var ErrTooLarge = errors.New("proto: frame too large")

type Frame struct {
	Type    Type
	Payload []byte
}

type Reader struct{ r *bufio.Reader }

func NewReader(r io.Reader) *Reader { return &Reader{r: bufio.NewReader(r)} }

func (r *Reader) Next() (Frame, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r.r, hdr[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return Frame{}, fmt.Errorf("proto: truncated header: %w", err)
		}
		return Frame{}, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > MaxPayload {
		return Frame{}, ErrTooLarge
	}
	f := Frame{Type: Type(hdr[0]), Payload: make([]byte, n)}
	if _, err := io.ReadFull(r.r, f.Payload); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return Frame{}, fmt.Errorf("proto: truncated %s payload: %w", f.Type, err)
	}
	return f, nil
}

type Writer struct {
	mu sync.Mutex
	w  io.Writer
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

func (w *Writer) Write(t Type, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	for {
		chunk := payload
		if len(chunk) > MaxPayload {
			chunk = chunk[:MaxPayload]
		}
		buf := make([]byte, 5+len(chunk))
		buf[0] = byte(t)
		binary.BigEndian.PutUint32(buf[1:], uint32(len(chunk)))
		copy(buf[5:], chunk)
		if _, err := w.w.Write(buf); err != nil {
			return err
		}
		payload = payload[len(chunk):]
		if len(payload) == 0 {
			return nil
		}
	}
}

func (w *Writer) WriteMessage(t Type, m protoreflect.ProtoMessage) error {
	b, err := Marshal(m)
	if err != nil {
		return err
	}
	return w.Write(t, b)
}

// An older impd requires every field without presence, zero or not, and a
// newer impd may send a field this agent lacks.
var (
	marshalOptions   = protojson.MarshalOptions{UseProtoNames: true, EmitDefaultValues: true}
	unmarshalOptions = protojson.UnmarshalOptions{DiscardUnknown: true}
)

func Marshal(m protoreflect.ProtoMessage) ([]byte, error) {
	return marshalOptions.Marshal(m)
}

func Unmarshal(b []byte, m protoreflect.ProtoMessage) error {
	return unmarshalOptions.Unmarshal(b, m)
}
