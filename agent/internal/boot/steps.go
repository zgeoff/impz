package boot

import (
	"time"

	"github.com/zgeoff/impz/agent/internal/proto"
)

// bootSteps times the boot's steps for ping, each from the end of the one
// before it, so impd can log where a boot's time goes.
type bootSteps struct {
	now   func() time.Time
	last  time.Time
	steps []*proto.BootStep
}

func newBootSteps(now func() time.Time) *bootSteps {
	return &bootSteps{now: now, last: now()}
}

// restart drops the steps so far and times the next from now: for a boot
// template, whose steps before the claim ran before its snapshot.
func (b *bootSteps) restart() {
	b.last = b.now()
	b.steps = nil
}

// mark ends the step called name.
func (b *bootSteps) mark(name string) {
	now := b.now()
	b.steps = append(b.steps, &proto.BootStep{Name: name, Ms: uint32(now.Sub(b.last).Milliseconds())})
	b.last = now
}
