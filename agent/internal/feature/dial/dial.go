package dial

import (
	"errors"
	"fmt"
	"io"
	"net"
	"time"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// dialTimeout bounds the connect, so a filtered port fails instead of
// holding the host's channel open.
const dialTimeout = 5 * time.Second

const impDir = "/run/imp"

const chunk = 32 << 10

type halfCloser interface {
	CloseWrite() error
}

func (d *Dialer) Serve(req *proto.Request, r *proto.Reader, w *proto.Writer) error {
	target, err := d.open(req)
	if err != nil {
		return proto.ReplyError(w, err)
	}
	defer target.Close()
	if err := w.WriteMessage(proto.TypeResponse, &proto.OK{Ok: true}); err != nil {
		return err
	}
	return Relay(target, r, w)
}

func Relay(target net.Conn, r *proto.Reader, w *proto.Writer) error {
	outbound := make(chan error, 1)
	safe.Go("relay output", func() {
		outbound <- pumpOut(target, w)
	}, func() {
		outbound <- errors.New("relay output panicked")
	})

	// Reads past STDIN_EOF until the host closes the connection, so a host
	// that gives up is seen even while the target is quiet.
	halfClosed := make(chan struct{})
	inbound := make(chan error, 1)
	safe.Go("relay input", func() {
		inbound <- pumpIn(r, target, halfClosed)
	}, func() {
		inbound <- errors.New("relay input panicked")
	})

	outDone := false
	for {
		select {
		case err := <-outbound:
			if err != nil {
				return err
			}
			outDone = true
		case <-halfClosed:
			halfClosed = nil
		case err := <-inbound:
			return err
		}
		if outDone && halfClosed == nil {
			return nil
		}
	}
}

func (d *Dialer) open(req *proto.Request) (net.Conn, error) {
	if req.GetNetwork() != "tcp" && req.GetNetwork() != "unix" {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: fmt.Sprintf("network must be tcp or unix, got %q", req.GetNetwork())}
	}
	if req.GetAddress() == "" {
		return nil, &proto.Error{Code: proto.ErrBadRequest, Message: "address is required"}
	}
	if req.GetNetwork() == "unix" {
		return d.openUnix(req.GetAddress())
	}
	c, err := net.DialTimeout(req.GetNetwork(), req.GetAddress(), dialTimeout)
	if err != nil {
		return nil, &proto.Error{Code: proto.ErrDialFailed, Message: err.Error()}
	}
	return c, nil
}

func pumpOut(target net.Conn, w *proto.Writer) error {
	buf := make([]byte, chunk)
	for {
		n, err := target.Read(buf)
		if n > 0 {
			if werr := w.Write(proto.TypeStdout, buf[:n]); werr != nil {
				return werr
			}
		}
		if errors.Is(err, io.EOF) {
			return w.Write(proto.TypeStdoutEOF, nil)
		}
		if err != nil {
			return err
		}
	}
}

func pumpIn(r *proto.Reader, target net.Conn, halfClosed chan<- struct{}) error {
	ended := false
	for {
		f, err := r.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read from the host: %w", err)
		}
		switch {
		case f.Type == proto.TypeStdin && !ended:
			if _, err := target.Write(f.Payload); err != nil {
				return err
			}
		case f.Type == proto.TypeStdinEOF && !ended:
			ended = true
			if hc, ok := target.(halfCloser); ok {
				if err := hc.CloseWrite(); err != nil {
					return err
				}
			}
			close(halfClosed)
		}
	}
}
