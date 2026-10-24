package boot

import (
	"time"

	"github.com/zgeoff/impz/agent/internal/proto"
)

type bootSteps struct {
	now   func() time.Time
	last  time.Time
	steps []*proto.BootStep
}

func newBootSteps(now func() time.Time) *bootSteps {
	return &bootSteps{now: now, last: now()}
}

func (b *bootSteps) restart() {
	b.last = b.now()
	b.steps = nil
}

func (b *bootSteps) mark(name string) {
	now := b.now()
	b.steps = append(b.steps, &proto.BootStep{Name: name, Ms: uint32(now.Sub(b.last).Milliseconds())})
	b.last = now
}
