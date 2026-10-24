package imagecfg

import (
	"encoding/json"
	"errors"
	"io/fs"
	"sync/atomic"

	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/proc"
)

const Path = "/etc/imp/image.json"

type Config struct {
	Env     []string `json:"env"`
	Workdir string   `json:"workdir"`
	User    string   `json:"user"`
}

var defaultEnv = []string{
	"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
	"HOME=/root",
	"TERM=xterm-256color",
}

type Live struct{ p atomic.Pointer[Config] }

func NewLive(c Config) *Live {
	l := &Live{}
	l.Set(c)
	return l
}

func (l *Live) Get() Config  { return *l.p.Load() }
func (l *Live) Set(c Config) { l.p.Store(&c) }

func Load(fsys fsroot.FS) (Config, error) {
	return load(fsys, Path)
}

func load(fsys fsroot.FS, path string) (Config, error) {
	c := Config{}
	b, err := fsys.ReadFile(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
	case err != nil:
		return Config{Env: defaultEnv}, err
	default:
		if err := json.Unmarshal(b, &c); err != nil {
			return Config{Env: defaultEnv}, err
		}
	}
	c.Env = proc.Merge(defaultEnv, c.Env)
	return c, nil
}
