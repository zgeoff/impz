package proto

import "syscall"

// Input holds what each frame the host sends into a running process does.
// A nil handler ignores its frames.
type Input struct {
	Stdin    func(p []byte)
	StdinEOF func()
	// Resize gets a RESIZE frame that parses.
	Resize func(cols, rows uint16)
	// Signal gets a SIGNAL frame that parses and names a signal above 0.
	Signal func(sig syscall.Signal)
	// Other gets the type of every frame of any other type.
	Other func(t Type)
}

// Dispatch reads frames from r and hands each to its handler in in, until a
// read fails. It returns that error, which is io.EOF when the host closed the
// connection.
func Dispatch(r *Reader, in Input) error {
	for {
		f, err := r.Next()
		if err != nil {
			return err
		}
		switch f.Type {
		case TypeStdin:
			if in.Stdin != nil {
				in.Stdin(f.Payload)
			}
		case TypeStdinEOF:
			if in.StdinEOF != nil {
				in.StdinEOF()
			}
		case TypeResize:
			var rs Resize
			if in.Resize != nil && Unmarshal(f.Payload, &rs) == nil {
				in.Resize(uint16(rs.Cols), uint16(rs.Rows))
			}
		case TypeSignal:
			var sig Signal
			if in.Signal != nil && Unmarshal(f.Payload, &sig) == nil && sig.Signal > 0 {
				in.Signal(syscall.Signal(sig.Signal))
			}
		default:
			if in.Other != nil {
				in.Other(f.Type)
			}
		}
	}
}
