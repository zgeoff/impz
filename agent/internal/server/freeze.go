package server

import (
	"errors"
	"fmt"
	"log"
	"os"
	"time"

	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/inner"
	"github.com/zgeoff/impz/agent/internal/host/disk"
	"github.com/zgeoff/impz/agent/internal/proto"
)

// A host that crashes mid-checkpoint never sends thaw, and would leave the
// guest wedged.
const defaultFreezeTimeout = 30 * time.Second

// _IOWR('X', 119, int) and _IOWR('X', 120, int); x/sys/unix lacks them.
const (
	fiFreeze = 0xC0045877
	fiThaw   = 0xC0045878
)

var (
	errFrozen      = &proto.Error{Code: proto.ErrFrozen, Message: "the root filesystem is already frozen"}
	errPoweringOff = &proto.Error{Code: proto.ErrPoweringOff, Message: "the guest is powering off"}
)

func (s *Server) freeze(timeout time.Duration) error {
	if timeout <= 0 {
		timeout = defaultFreezeTimeout
	}
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	if s.poweringOff {
		return errPoweringOff
	}
	if s.frozen {
		return errFrozen
	}
	// No unix.Sync first: freeze_super syncs the filesystem itself, and a
	// global sync would block on another frozen filesystem.
	if err := s.ioctl(fiFreeze); err != nil {
		// EBUSY: frozen by someone else, such as fsfreeze in the guest.
		if errors.Is(err, unix.EBUSY) {
			return errFrozen
		}
		return fmt.Errorf("FIFREEZE: %w", err)
	}
	s.frozen = true
	s.freezeGen++
	gen := s.freezeGen
	// Stop cannot cancel a callback that already fired and waits on
	// freezeMu, so the callback checks that its freeze is still current.
	afterFunc := time.AfterFunc
	if s.afterFunc != nil {
		afterFunc = s.afterFunc
	}
	s.thawTimer = afterFunc(timeout, func() {
		defer safe.Recover("auto-thaw", nil)
		if s.autoThawFired != nil {
			s.autoThawFired()
		}
		s.freezeMu.Lock()
		defer s.freezeMu.Unlock()
		if gen != s.freezeGen {
			return
		}
		log.Printf("freeze: no thaw after %s, thawing", timeout)
		if err := s.thawLocked(); err != nil {
			log.Printf("freeze: auto-thaw: %v", err)
		}
	})
	return nil
}

const growTimeout = 10 * time.Second

// A frozen filesystem would block the resize. impd orders grow, freeze and
// thaw under the imp's lock; the mutex guards the agent's own state, whatever
// the order they arrive in.
func (s *Server) grow(diskBytes int64) error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	if s.frozen {
		return errFrozen
	}
	waitAndGrow := disk.WaitAndGrow
	if s.waitAndGrow != nil {
		waitAndGrow = s.waitAndGrow
	}
	return waitAndGrow(inner.UserRoot, diskBytes, growTimeout)
}

func (s *Server) thaw() error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	return s.thawLocked()
}

// Poweroff stops processes, syncs and remounts, which a frozen filesystem
// would block.
func (s *Server) ThawForPoweroff() error {
	s.freezeMu.Lock()
	defer s.freezeMu.Unlock()
	s.poweringOff = true
	return s.thawLocked()
}

func (s *Server) thawLocked() error {
	s.freezeGen++
	if s.thawTimer != nil {
		s.thawTimer.Stop()
		s.thawTimer = nil
	}
	if err := s.ioctl(fiThaw); err != nil && err != unix.EINVAL {
		return fmt.Errorf("FITHAW: %w", err)
	}
	s.frozen = false
	return nil
}

func (s *Server) ioctl(req uint) error {
	if s.rootIoctl != nil {
		return s.rootIoctl(req)
	}
	return ioctlRoot(req)
}

func ioctlRoot(req uint) error {
	f, err := os.Open(inner.UserRoot)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = unix.IoctlRetInt(int(f.Fd()), req)
	return err
}
