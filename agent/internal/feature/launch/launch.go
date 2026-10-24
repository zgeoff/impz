package launch

import (
	"errors"
	"log"
	"os"

	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/pty"
	"github.com/zgeoff/impz/agent/internal/proto"
)

const (
	defaultCols = 80
	defaultRows = 24
)

type Launcher struct {
	runner proc.Runner
	image  *imagecfg.Live
	ptys   func() (master, slave *os.File, err error)
}

func New(runner proc.Runner, image *imagecfg.Live, openPTY func() (master, slave *os.File, err error)) *Launcher {
	if openPTY == nil {
		openPTY = pty.Open
	}
	return &Launcher{runner: runner, image: image, ptys: openPTY}
}

func (l *Launcher) Spec(req *proto.Request) (proc.Spec, error) {
	if len(req.Argv) == 0 {
		return proc.Spec{}, errors.New("argv is empty")
	}
	image := l.image.Get()
	user := req.GetUser()
	if user == "" {
		user = image.User
	}
	return proc.Spec{
		Argv:    req.Argv,
		Env:     proc.Merge(image.Env, req.Env),
		Dir:     req.GetCwd(),
		Workdir: image.Workdir,
		User:    user,
		SetHome: true,
		// the image's own start-up runs as services, outside this
		DropSysAdmin: req.GetDropSysAdmin(),
	}, nil
}

func (l *Launcher) Start(spec proc.Spec) (*proc.Process, error) {
	return l.runner.Start(spec)
}

func (l *Launcher) StartPTY(req *proto.Request, cgroup *os.File) (*proc.Process, *os.File, error) {
	spec, err := l.Spec(req)
	if err != nil {
		return nil, nil, err
	}
	master, slave, err := l.ptys()
	if err != nil {
		return nil, nil, err
	}
	cols, rows := uint16(req.GetCols()), uint16(req.GetRows())
	if cols == 0 || rows == 0 {
		cols, rows = defaultCols, defaultRows
	}
	if err := pty.SetWinsize(master, cols, rows); err != nil {
		log.Printf("launch: winsize: %v", err)
	}
	spec.TTY = true
	spec.Cgroup = cgroup
	spec.Files = []*os.File{slave, slave, slave}
	p, err := l.Start(spec)
	slave.Close()
	if err != nil {
		master.Close()
		return nil, nil, err
	}
	return p, master, nil
}
