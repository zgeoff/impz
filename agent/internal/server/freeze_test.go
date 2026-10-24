package server

import (
	"slices"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"golang.org/x/sys/unix"
	"gotest.tools/v3/assert"
	"gotest.tools/v3/assert/cmp"
)

type fakeIoctl struct {
	mu    sync.Mutex
	calls []uint
}

func (f *fakeIoctl) ioctl(req uint) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, req)
	return nil
}

func (f *fakeIoctl) get() []uint {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

// The auto-thaw timer runs on synctest's fake clock.
func TestFreezeThawsItselfWhenTheTimeoutPasses(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var f fakeIoctl
		s := &Server{rootIoctl: f.ioctl}
		assert.NilError(t, s.freeze(time.Second))

		time.Sleep(time.Second - time.Nanosecond)
		synctest.Wait()
		before := f.get()
		time.Sleep(time.Nanosecond)
		synctest.Wait()

		assert.Check(t, cmp.DeepEqual(before, []uint{fiFreeze}))
		assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
	})
}

func TestFreezeWithoutATimeoutThawsItselfAfterTheDefault(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var f fakeIoctl
		s := &Server{rootIoctl: f.ioctl}
		assert.NilError(t, s.freeze(0))

		time.Sleep(defaultFreezeTimeout - time.Nanosecond)
		synctest.Wait()
		before := f.get()
		time.Sleep(time.Nanosecond)
		synctest.Wait()

		assert.Check(t, cmp.DeepEqual(before, []uint{fiFreeze}))
		assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
	})
}

// Timer.Stop cannot stop a callback that fired and blocks on the lock, so the
// test runs the first freeze's callback itself, after the thaw and the next
// freeze, as the blocked callback would once it took the lock.
func TestStaleAutoThawLeavesALaterFreezeFrozen(t *testing.T) {
	var f fakeIoctl
	var callbacks []func()
	s := &Server{rootIoctl: f.ioctl, afterFunc: func(d time.Duration, fn func()) *time.Timer {
		callbacks = append(callbacks, fn)
		return time.AfterFunc(d, func() {})
	}}
	assert.NilError(t, s.freeze(time.Millisecond))
	t.Cleanup(func() { s.thaw() })
	assert.NilError(t, s.thaw())
	assert.NilError(t, s.freeze(time.Hour))

	callbacks[0]()

	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
	assert.Check(t, s.frozen, "the later freeze still holds")
}

func TestAutoThawThatFiresWhileTheLockIsHeldWaitsAndThenLeavesALaterFreeze(t *testing.T) {
	var f fakeIoctl
	var callbacks []func()
	s := &Server{rootIoctl: f.ioctl, afterFunc: func(d time.Duration, fn func()) *time.Timer {
		callbacks = append(callbacks, fn)
		return time.AfterFunc(time.Hour, func() {})
	}}
	assert.NilError(t, s.freeze(time.Millisecond))
	t.Cleanup(func() { s.thaw() })
	autoThaw := callbacks[0]
	started := make(chan struct{})
	s.autoThawFired = func() { close(started) }
	s.freezeMu.Lock()
	held := true
	fired := make(chan struct{})
	go func() {
		defer close(fired)
		autoThaw()
	}()
	// after a failure below, let the callback have the lock and join it
	t.Cleanup(func() {
		if held {
			s.freezeMu.Unlock()
		}
		select {
		case <-fired:
		case <-time.After(5 * time.Second):
			t.Error("the auto-thaw callback did not return")
		}
	})
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("the callback never started")
	}

	thawErr := s.thawLocked()
	held = false
	s.freezeMu.Unlock()
	freezeErr := s.freeze(time.Hour)
	select {
	case <-fired:
	case <-time.After(5 * time.Second):
		t.Fatal("the callback never took the lock")
	}

	assert.Check(t, thawErr)
	assert.Check(t, freezeErr)
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
	assert.Check(t, s.frozen, "the later freeze still holds")
}

func TestFreezeRefusesASecondFreezeAsFrozen(t *testing.T) {
	var f fakeIoctl
	s := &Server{rootIoctl: f.ioctl}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, errFrozen))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze}), "the refused freeze issued no ioctl")
}

func TestThawThawsASecondFreeze(t *testing.T) {
	var f fakeIoctl
	s := &Server{rootIoctl: f.ioctl}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })
	assert.NilError(t, s.thaw())
	assert.NilError(t, s.freeze(time.Hour))

	err := s.thaw()

	assert.Check(t, err)
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze, fiThaw}))
	assert.Check(t, !s.frozen, "the second freeze still holds")
}

func TestFreezeSucceedsAgainAfterAThaw(t *testing.T) {
	var f fakeIoctl
	s := &Server{rootIoctl: f.ioctl}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })
	assert.NilError(t, s.thaw())

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw, fiFreeze}))
}

// EBUSY is a filesystem frozen from inside the guest.
func TestFreezeOfARootFrozenInTheGuestIsFrozen(t *testing.T) {
	s := &Server{rootIoctl: func(uint) error { return unix.EBUSY }}

	err := s.freeze(time.Hour)

	assert.ErrorIs(t, err, errFrozen)
}

func TestFreezeReportsAnotherIoctlFailure(t *testing.T) {
	s := &Server{rootIoctl: func(uint) error { return unix.EPERM }}

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, unix.EPERM))
	assert.Check(t, !s.frozen, "a failed freeze left the server frozen")
}

func TestThawOfAnUnfrozenRootIsNotAnError(t *testing.T) {
	s := &Server{rootIoctl: func(uint) error { return unix.EINVAL }}

	err := s.thaw()

	assert.NilError(t, err)
}

func TestThawForPoweroffThawsAFrozenRoot(t *testing.T) {
	var f fakeIoctl
	s := &Server{rootIoctl: f.ioctl}
	assert.NilError(t, s.freeze(time.Hour))
	t.Cleanup(func() { s.thaw() })

	err := s.ThawForPoweroff()

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiFreeze, fiThaw}))
}

func TestFreezeAfterThawForPoweroffIsPoweringOff(t *testing.T) {
	var f fakeIoctl
	s := &Server{rootIoctl: f.ioctl}
	assert.NilError(t, s.ThawForPoweroff())

	err := s.freeze(time.Hour)

	assert.Check(t, cmp.ErrorIs(err, errPoweringOff))
	assert.Check(t, cmp.DeepEqual(f.get(), []uint{fiThaw}), "the refused freeze issued no ioctl")
}

type fakeGrow struct {
	grown []int64
}

func (g *fakeGrow) waitAndGrow(_ string, target int64, _ time.Duration) error {
	g.grown = append(g.grown, target)
	return nil
}

func TestGrowWhileFrozenIsRefusedAsFrozen(t *testing.T) {
	var f fakeIoctl
	var g fakeGrow
	s := &Server{rootIoctl: f.ioctl, waitAndGrow: g.waitAndGrow}
	assert.NilError(t, s.freeze(time.Minute))
	t.Cleanup(func() { s.thaw() })

	err := s.grow(1 << 30)

	assert.Check(t, cmp.ErrorIs(err, errFrozen))
	assert.Check(t, cmp.Len(g.grown, 0), "the refused grow reached the disk")
}

func TestGrowAfterAThawGrowsTheDisk(t *testing.T) {
	var f fakeIoctl
	var g fakeGrow
	s := &Server{rootIoctl: f.ioctl, waitAndGrow: g.waitAndGrow}
	assert.NilError(t, s.freeze(time.Minute))
	t.Cleanup(func() { s.thaw() })
	assert.NilError(t, s.thaw())

	err := s.grow(1 << 30)

	assert.Check(t, cmp.Nil(err))
	assert.Check(t, cmp.DeepEqual(g.grown, []int64{1 << 30}))
}
