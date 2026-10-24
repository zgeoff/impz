package proto

import "syscall"

type Input struct {
	Stdin    func(p []byte)
	StdinEOF func()
	Resize   func(cols, rows uint16)
	Signal   func(sig syscall.Signal)
	Other    func(t Type)
}

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
