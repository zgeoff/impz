package boot

import (
	"fmt"
	"testing"
	"time"

	"gotest.tools/v3/assert"
)

type stepClock struct{ at time.Time }

func (c *stepClock) now() time.Time { return c.at }

func (c *stepClock) advance(d time.Duration) { c.at = c.at.Add(d) }

func formatSteps(b *bootSteps) []string {
	var out []string
	for _, step := range b.steps {
		out = append(out, fmt.Sprintf("%s=%d", step.GetName(), step.GetMs()))
	}
	return out
}

func TestBootStepsTimeEachStepFromTheOneBefore(t *testing.T) {
	clock := &stepClock{at: time.Unix(1_700_000_000, 0)}
	steps := newBootSteps(clock.now)

	clock.advance(40 * time.Millisecond)
	steps.mark("mount")
	steps.mark("grow")
	clock.advance(7500 * time.Microsecond)
	steps.mark("network")

	assert.DeepEqual(t, formatSteps(steps), []string{"mount=40", "grow=0", "network=7"})
}

// A boot template's steps before its claim ran before the snapshot, so the
// restored copy's first step starts at the claim.
func TestBootStepsRestartDropsTheStepsBeforeIt(t *testing.T) {
	clock := &stepClock{at: time.Unix(1_700_000_000, 0)}
	steps := newBootSteps(clock.now)
	clock.advance(time.Second)
	steps.mark("world")

	clock.advance(time.Hour)
	steps.restart()
	clock.advance(12 * time.Millisecond)
	steps.mark("claim")

	assert.DeepEqual(t, formatSteps(steps), []string{"claim=12"})
}
