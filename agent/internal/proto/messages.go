package proto

import "errors"

const Version = "0.21.0"

const (
	OpPing         = "ping"
	OpExec         = "exec"
	OpFreeze       = "freeze"
	OpThaw         = "thaw"
	OpActivity     = "activity"
	OpResumed      = "resumed"
	OpShutdown     = "shutdown"
	OpServicesList = "services.list"
	OpGrow         = "grow"

	OpServicesAdd     = "services.add"
	OpServicesRemove  = "services.remove"
	OpServicesRestart = "services.restart"
	OpServicesLogs    = "services.logs"

	OpSessionAttach = "session.attach"
	OpSessionKill   = "session.kill"

	OpSessionTap = "session.tap"

	OpDial = "dial"

	OpAgentListen = "agent.listen"
	OpAgentAccept = "agent.accept"

	OpListen = "listen"

	OpExecOuter = "exec.outer"

	OpClaim = "claim"

	OpFilesWrite  = "files.write"
	OpFilesRemove = "files.remove"
)

// The message types are generated from proto/imp/agent/v1/agent.proto into
// agent.pb.go (bun run gen:proto).

const (
	ErrBadRequest    = "BAD_REQUEST"
	ErrUnknownOp     = "UNKNOWN_OP"
	ErrExecFailed    = "EXEC_FAILED"
	ErrInnerDown     = "INNER_DOWN"
	ErrFrozen        = "FROZEN"
	ErrPoweringOff   = "POWERING_OFF"
	ErrInternal      = "INTERNAL"
	ErrNoSession     = "NO_SESSION"
	ErrInvalidResume = "INVALID_RESUME"
	ErrSessionCap    = "SESSION_LIMIT"
	ErrDialFailed    = "DIAL_FAILED"
	ErrNoConnection  = "NO_CONNECTION"
	ErrListenFailed  = "LISTEN_FAILED"
	ErrNoService     = "NO_SERVICE"
	ErrServiceTaken  = "SERVICE_EXISTS"
	ErrNoSpace       = "NO_SPACE"
)

func (e *Error) Error() string { return e.Code + ": " + e.Message }

const StageTemplate = "template"

const (
	IdentityResetOK     = "ok"
	IdentityResetFailed = "failed"
)

func ReplyError(w *Writer, err error) error {
	var pe *Error
	if !errors.As(err, &pe) {
		pe = &Error{Code: ErrInternal, Message: err.Error()}
	}
	return w.WriteMessage(TypeResponse, &ErrorResponse{Error: pe})
}

func StartError(err error, down bool) *Error {
	if down {
		return &Error{Code: ErrInnerDown, Message: err.Error()}
	}
	return &Error{Code: ErrExecFailed, Message: err.Error()}
}

const (
	SessionRunning = "running"
	SessionExited  = "exited"
)

const (
	ResumeExact             = "exact"
	ResumeGap               = "gap"
	ResumeGenerationChanged = "generation_changed"
)

const (
	DetachTakenOver = "taken_over"
	DetachSlow      = "slow"
)

func ExitOf(code, signal int) *Exit {
	if signal != 0 {
		return &Exit{Code: int32(128 + signal), Signal: int32(signal)}
	}
	return &Exit{Code: int32(code)}
}
