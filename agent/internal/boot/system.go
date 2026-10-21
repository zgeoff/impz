package boot

import (
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/mdlayher/vsock"
	"golang.org/x/sys/unix"

	"github.com/zgeoff/impz/agent/internal/base/reaper"
	"github.com/zgeoff/impz/agent/internal/base/safe"
	"github.com/zgeoff/impz/agent/internal/feature/claim"
	"github.com/zgeoff/impz/agent/internal/feature/dial"
	"github.com/zgeoff/impz/agent/internal/feature/exec"
	"github.com/zgeoff/impz/agent/internal/feature/files"
	"github.com/zgeoff/impz/agent/internal/feature/identity"
	"github.com/zgeoff/impz/agent/internal/feature/inner"
	"github.com/zgeoff/impz/agent/internal/feature/launch"
	"github.com/zgeoff/impz/agent/internal/feature/listen"
	"github.com/zgeoff/impz/agent/internal/feature/memory"
	"github.com/zgeoff/impz/agent/internal/feature/outer"
	"github.com/zgeoff/impz/agent/internal/feature/poweroff"
	"github.com/zgeoff/impz/agent/internal/feature/services"
	"github.com/zgeoff/impz/agent/internal/feature/session"
	"github.com/zgeoff/impz/agent/internal/host/cgroup"
	"github.com/zgeoff/impz/agent/internal/host/cmdline"
	"github.com/zgeoff/impz/agent/internal/host/fsroot"
	"github.com/zgeoff/impz/agent/internal/host/hosts"
	"github.com/zgeoff/impz/agent/internal/host/imagecfg"
	"github.com/zgeoff/impz/agent/internal/host/netcfg"
	"github.com/zgeoff/impz/agent/internal/host/proc"
	"github.com/zgeoff/impz/agent/internal/host/pty"
	"github.com/zgeoff/impz/agent/internal/proto"
	"github.com/zgeoff/impz/agent/internal/server"
)

// Run is PID 1 from the system drive. It mounts the agent's world and the
// user disk, starts the inner container on it, configures the hostname and
// network, starts services, and serves the host on vsock. It returns only on
// failure.
func Run() error {
	steps := newBootSteps(time.Now)
	r := reaper.New()

	if err := setupAgentWorld(); err != nil {
		return err
	}
	protectAgent()
	if err := setupUserCgroup(); err != nil {
		return err
	}
	params, err := cmdline.Read()
	if err != nil {
		return err
	}
	if follow := memory.Follower(params); follow != nil {
		go follow()
	}
	// a boot template parks here, before the user disk is touched; the
	// restored copy goes on with its claim's values, never the template's
	// cmdline
	claimed := params.Template
	if params.Template {
		c, err := claim.Park(listenVsock, buildPing, func(c *proto.Claim) error {
			steps.restart()
			return claim.Apply(c, inner.UserDisk)
		})
		if err != nil {
			return err
		}
		params = claim.Params(c)
		steps.mark("claim")
	} else {
		steps.mark("world")
	}
	// the container's init starts up while the agent mounts the disk it
	// runs on
	mgr := inner.New(r, inner.Config{RunSize: innerRunSize()})
	mPre := inner.Mono()
	mgr.Prestart()
	if err := inner.MountUserDisk(); err != nil {
		return err
	}
	steps.mark("mount")
	growUserDisk()
	steps.mark("grow")
	// the files go on the disk while the container starts up
	rootFiles := make(chan struct{})
	safe.Go("boot: root files", func() {
		defer close(rootFiles)
		writeRootFilesOnDisk(params)
	}, nil)
	// Problems below are logged, not fatal: an agent that answers on vsock
	// with a broken network or a dead container is still reachable to debug.
	if params.Hostname != "" {
		if err := unix.Sethostname([]byte(params.Hostname)); err != nil {
			log.Printf("hostname: %v", err)
		}
	}
	if err := netcfg.Up("eth0", params.IP, params.GW); err != nil {
		log.Printf("network: %v", err)
	}
	if err := netcfg.Up6("eth0", params.IP6, params.GW6); err != nil {
		log.Printf("network (IPv6): %v", err)
	}
	steps.mark("network")

	root := mgr.Root()
	image := imagecfg.NewLive(imagecfg.Config{})
	sup := services.New(mgr, root, image)
	launcher := launch.New(mgr, image, func() (*os.File, *os.File, error) { return pty.OpenIn(root) })
	dialer := dial.NewDialer(mgr, image)
	listener := listen.NewManager(listen.AgentRoot, listen.ForwardRoot, image, dialer, root)

	// The services and the sockets in the old container's /run went with
	// it. A new container gets its files set and its image config read
	// again, as at boot, and its services.
	mgr.OnDown(func() {
		listener.CloseLost()
		sup.Suspend()
	})
	mgr.OnUp(func() {
		prepareRoot(root, params, image)
		if err := sup.Reload(); err != nil {
			log.Printf("services: %v", err)
		}
	})
	// with the container down, the image config stays at its defaults
	// until it starts
	steps.mark("i.new")
	mgr.Launch()
	for _, t := range inner.TakeTrace() {
		steps.steps = append(steps.steps, &proto.BootStep{Name: t.Name, Ms: uint32(max(t.Mono-mPre, 0) / 1e6)})
	}
	steps.mark("inner")
	<-rootFiles
	loadImageConfig(root, image)
	steps.mark("root")
	identityReset := ""
	if params.ResetIdentity {
		identityReset = identity.Reset(mgr, root, image.Get().Env)
		steps.mark("identity")
	}
	if err := sup.Load(); err != nil {
		log.Printf("services: %v", err)
	}
	steps.mark("services")

	// Each non-tty exec gets a cgroup leaf, so a stop kills its escapees too,
	// and a memory controller, so a command can cap its own memory
	// (docs/architecture/guest/agent.md#execs-and-services).
	execCgroups, err := cgroup.NewDelegatedTree(inner.ExecCgroupDir, "memory")
	if err != nil {
		log.Printf("boot: exec cgroups: %v; a stop reaches only the process group", err)
		execCgroups = nil
	}
	// An outer exec runs in the agent's world, while the container is down
	// too, in its own cgroup and memory limit or not at all.
	outerCgroups, err := outer.Setup()
	if err != nil {
		log.Printf("boot: outer exec: %v; every one is refused", err)
	}
	outerRunner := outer.Runner{Next: &proc.Direct{Reaper: r, Agent: inner.AgentBinary}}
	bootID := identity.ReadBootID()
	if claimed {
		bootID = identity.NewBootID()
	}
	srv := &server.Server{
		Exec:     exec.NewManager(launcher, execCgroups),
		Outer:    exec.NewStrictManager(launch.New(outerRunner, outer.Image(), pty.Open), outerCgroups),
		Sessions: session.NewManager(launcher, bootID),
		Services: sup,
		Listen:   listener,
		Dial:     dialer,
		Files:    files.New(files.Dir),
		Inner: func() *proto.InnerStatus {
			st := mgr.Status()
			status := &proto.InnerStatus{Up: st.Up, Restarts: uint32(st.Restarts)}
			if st.LastErr != "" {
				status.LastError = new(st.LastErr)
			}
			return status
		},

		IdentityReset: identityReset,
		BootID:        bootID,
	}

	// A shutdown request and a signal can race; only the first powers off.
	// A panic on the way must still end the guest, so it falls back to a
	// thaw (sync would block on a frozen disk), sync and reboot.
	powerOff := sync.OnceFunc(func() {
		defer safe.Recover("poweroff", func() {
			safe.Call("poweroff: thaw", func() { _ = srv.ThawForPoweroff() })
			unix.Sync()
			poweroff.Reboot()
		})
		poweroff.Run(sup, mgr, srv.ThawForPoweroff)
	})
	srv.Shutdown = powerOff

	// Ctrl-Alt-Del (Firecracker's SendCtrlAltDel) arrives as SIGINT once
	// CAD is off; SIGTERM is the conventional "stop" for init.
	if err := unix.Reboot(unix.LINUX_REBOOT_CMD_CAD_OFF); err != nil {
		log.Printf("cad off: %v", err)
	}
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	safe.Go("signals", func() {
		sig := <-sigs
		log.Printf("%v: shutting down", sig)
		powerOff()
	}, nil)

	steps.mark("ready")
	srv.BootSteps = steps.steps
	return srv.Serve(listenVsock)
}

// prepareRoot writes the files of the user's root that follow the imp,
// then reads the image config.
func prepareRoot(root fsroot.FS, params cmdline.Params, image *imagecfg.Live) {
	writeRootFiles(root, params)
	loadImageConfig(root, image)
}

// writeRootFiles writes the files of the user's root that follow the imp
// rather than the image: hostname, hosts and resolv.conf. A fork or rename
// gives the imp a new hostname on the same disk.
func writeRootFiles(root fsroot.FS, params cmdline.Params) {
	if name := params.Hostname; name != "" {
		if err := fsroot.RewriteFile(root, "/etc/hostname", []byte(name+"\n"), 0o644); err != nil {
			log.Printf("hostname: %v", err)
		}
		if err := hosts.Update(root, "/etc/hosts", name); err != nil {
			log.Printf("hosts: %v", err)
		}
	}
	if err := netcfg.WriteResolvConf(root, params.DNS); err != nil {
		log.Printf("resolv.conf: %v", err)
	}
}

// writeRootFilesOnDisk writes the root's files through the user disk's own
// mount, which the agent has before the container is up. The container
// mounts nothing over /etc, so the files are the ones it sees.
func writeRootFilesOnDisk(params cmdline.Params) {
	root, err := fsroot.Open(inner.UserRoot)
	if err != nil {
		log.Printf("boot: open %s: %v", inner.UserRoot, err)
		return
	}
	defer root.Close()
	writeRootFiles(root, params)
}

func loadImageConfig(root fsroot.FS, image *imagecfg.Live) {
	cfg, err := imagecfg.Load(root)
	if err != nil {
		log.Printf("%s: %v (using defaults)", imagecfg.Path, err)
	}
	image.Set(cfg)
}

// buildPing answers a parked boot template's ping as the server would.
func buildPing() *proto.Ping {
	return server.BuildPing(unix.ClockGettime)
}

// listenVsock listens on the agent's port, for a boot template parked for
// its claim and for the agent's server.
func listenVsock() (net.Listener, error) {
	l, err := vsock.Listen(server.Port, nil)
	if err != nil {
		return nil, fmt.Errorf("vsock listen: %w", err)
	}
	log.Printf("boot: ready on vsock port %d", server.Port)
	return l, nil
}
