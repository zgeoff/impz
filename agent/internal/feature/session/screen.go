package session

type Screen interface {
	Write(p []byte)
	Replay() (prelude, kept []byte)
}

// The replay shows the output at the width it was written for; a
// full-screen program draws itself again when the viewer's resize sends
// SIGWINCH.
type history struct {
	limit int
	buf   []byte
	start *modes
}

func newHistory(limit int) *history {
	return &history{limit: limit, buf: make([]byte, 0, 2*limit), start: newModes()}
}

func (h *history) Write(p []byte) {
	if len(h.buf)+len(p) > 2*h.limit {
		p = h.drop(len(h.buf)+len(p)-h.limit, p)
	}
	h.buf = append(h.buf, p...)
}

// Cuts only where the parser is between sequences: a replay that started
// inside an escape sequence or a UTF-8 character would show garbage.
func (h *history) drop(n int, p []byte) []byte {
	k := min(n, len(h.buf))
	cut := h.skip(h.buf, k)
	ground := cut < len(h.buf)
	h.buf = h.buf[:copy(h.buf, h.buf[cut:])]
	if ground {
		return p
	}
	return p[h.skip(p, n-k):]
}

func (h *history) skip(b []byte, k int) int {
	for _, c := range b[:k] {
		h.start.advance(c)
	}
	for k < len(b) && !h.start.atGround() {
		h.start.advance(b[k])
		k++
	}
	return k
}

func (h *history) Replay() (prelude, kept []byte) {
	return h.start.sequence(), h.buf
}
