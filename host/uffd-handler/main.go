// uffd-handler serves one Firecracker's guest memory from a snapshot's memory
// file, on demand, through the userfaultfd that Firecracker's Uffd backend
// sends it. impd starts one per VM that restores on 2 MiB pages. After a sleep
// on 2 MiB pages, impd also runs it with --count-data and --warm, which read
// the new memory file's data blocks into the page cache for the next wake, or
// with --count-blocks and --warm-blocks, which do so for the blocks that the
// last run served, --warm-blocks in the order of their first fault and up to a
// limit.
package main

import (
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

// impd passes the memory file as this descriptor, so a sleep can copy the file
// through /proc after the snapshot that held it is gone.
const memFileFD = 3

// impd reads the handler's counts for a wake from this descriptor's file.
const statsFD = 4

// impd passes a file as this descriptor, for the handler to mark the blocks it
// serves in, and keeps it for the next sleep's warm.
const touchedFD = 5

// Firecracker connects during its snapshot load, which impd sends right after
// the socket appears.
const acceptTimeout = 30 * time.Second

type owner struct {
	uid int
	gid int
}

type options struct {
	socket string
	owner  *owner
}

func main() {
	if req, ok := parseWarmMode(os.Args[1:]); ok {
		if err := runWarm(req, os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "uffd-handler: %v\n", err)
			os.Exit(1)
		}
		return
	}

	opts, err := parseOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintf(os.Stderr, "uffd-handler: %v\nusage: uffd-handler --socket PATH [--uid UID --gid GID] 3<MEMORY_FILE 4<>STATS_FILE 5<>TOUCHED_FILE\n       uffd-handler --count-data|--warm MEMORY_FILE\n       uffd-handler --count-blocks BLOCK_LIST MEMORY_FILE\n       uffd-handler --warm-blocks BLOCK_LIST MEMORY_FILE LIMIT\n", err)
		os.Exit(2)
	}

	if err := run(opts, os.NewFile(memFileFD, "memory file"), os.NewFile(statsFD, "stats file"), os.NewFile(touchedFD, "touched file")); err != nil {
		fmt.Fprintf(os.Stderr, "uffd-handler: %v\n", err)
		os.Exit(1)
	}
}

func parseOptions(args []string) (options, error) {
	flags := flag.NewFlagSet("uffd-handler", flag.ContinueOnError)
	socket := flags.String("socket", "", "the path Firecracker's Uffd backend connects to")
	uid := flags.String("uid", "", "the uid to serve as, the jail's")
	gid := flags.String("gid", "", "the gid to serve as, the jail's")
	if err := flags.Parse(args); err != nil {
		return options{}, err
	}
	if *socket == "" {
		return options{}, errors.New("--socket is required")
	}
	if (*uid == "") != (*gid == "") {
		return options{}, errors.New("--uid and --gid go together")
	}
	opts := options{socket: *socket}
	if *uid == "" {
		return opts, nil
	}
	parsedUID, uidErr := strconv.Atoi(*uid)
	parsedGID, gidErr := strconv.Atoi(*gid)
	if uidErr != nil || gidErr != nil || parsedUID <= 0 || parsedGID <= 0 {
		return options{}, fmt.Errorf("--uid %q and --gid %q must be positive numbers", *uid, *gid)
	}
	opts.owner = &owner{uid: parsedUID, gid: parsedGID}
	return opts, nil
}

// run serves until Firecracker exits. Firecracker waits forever on a fault
// that nothing answers, so once it has connected, any failure kills it.
func run(opts options, memFile *os.File, statsFile *os.File, touchedFile *os.File) error {
	source, err := openMemSource(memFile)
	if err != nil {
		return err
	}
	defer source.close()

	stats, err := openHandlerStats(statsFile)
	if err != nil {
		return err
	}
	defer stats.close()

	// a nil touched marks nothing
	var touched *touchedBlocks
	if touchedFile != nil {
		touched, err = openTouchedBlocks(touchedFile, int64(len(source.mapped)))
		if err != nil {
			return err
		}
		defer touched.close()
	}

	listener, err := listen(opts.socket, opts.owner)
	if err != nil {
		return err
	}
	if opts.owner != nil {
		if err := dropPrivileges(*opts.owner); err != nil {
			listener.Close()
			return err
		}
	}

	conn, err := acceptPeer(listener)
	listener.Close()
	if err != nil {
		return err
	}
	defer unix.Close(conn.pidfd)

	err = serveConn(conn, source, stats, touched)
	if err != nil {
		// the peer may already be gone, which leaves nothing to stop
		_ = unix.PidfdSendSignal(conn.pidfd, unix.SIGKILL, nil, 0)
	}
	return err
}

func serveConn(conn peerConn, source *memSource, stats *handlerStats, touched *touchedBlocks) error {
	defer unix.Close(conn.uffd)
	h, err := newHandler(conn.uffd, conn.regions, source, stats)
	if err != nil {
		return err
	}
	h.touched = touched
	return h.serve(conn.pidfd)
}

// listen binds beside the path and renames the socket into place once its
// owner can connect, so impd, which waits for the path, never sends a load
// that Firecracker cannot connect for.
func listen(path string, socketOwner *owner) (*net.UnixListener, error) {
	staging := path + ".new"
	_ = os.Remove(staging)
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: staging, Net: "unix"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	if err := os.Chmod(staging, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	if socketOwner != nil {
		if err := os.Lchown(staging, socketOwner.uid, socketOwner.gid); err != nil {
			listener.Close()
			return nil, err
		}
	}
	if err := os.Rename(staging, path); err != nil {
		listener.Close()
		return nil, err
	}
	return listener, nil
}

// dropPrivileges serves as the jail's user, which owns the Firecracker it
// serves. A uid change also clears the dumpable flag, so that Firecracker
// cannot read this process's memory or descriptors through /proc.
func dropPrivileges(to owner) error {
	if err := unix.Setgroups(nil); err != nil {
		return fmt.Errorf("setgroups: %w", err)
	}
	if err := unix.Setresgid(to.gid, to.gid, to.gid); err != nil {
		return fmt.Errorf("setresgid %d: %w", to.gid, err)
	}
	if err := unix.Setresuid(to.uid, to.uid, to.uid); err != nil {
		return fmt.Errorf("setresuid %d: %w", to.uid, err)
	}
	return unix.Prctl(unix.PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)
}

func acceptPeer(listener *net.UnixListener) (peerConn, error) {
	if err := listener.SetDeadline(time.Now().Add(acceptTimeout)); err != nil {
		return peerConn{}, err
	}
	conn, err := listener.AcceptUnix()
	if err != nil {
		return peerConn{}, fmt.Errorf("no Firecracker connected: %w", err)
	}
	defer conn.Close()
	return readHandshake(conn)
}
