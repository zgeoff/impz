// impd's SSH gateway runs `/run/imp/sys/imp-agent sftp` from the system drive
// as an exec, so every image gets SFTP, with or without an sftp-server of its
// own.
package sftpserver

import (
	"errors"
	"io"
	"os"

	"github.com/pkg/sftp"
)

type stdio struct{}

func (stdio) Read(p []byte) (int, error)  { return os.Stdin.Read(p) }
func (stdio) Write(p []byte) (int, error) { return os.Stdout.Write(p) }

func (stdio) Close() error {
	return errors.Join(os.Stdin.Close(), os.Stdout.Close())
}

// Relative paths start at $HOME, as with OpenSSH's sftp-server.
func Run() error {
	return Serve(stdio{}, os.Getenv("HOME"))
}

func Serve(rwc io.ReadWriteCloser, home string) error {
	var options []sftp.ServerOption
	if home != "" {
		if info, err := os.Stat(home); err == nil && info.IsDir() { //nolint:gosec // G703: the user's own $HOME, read with the user's rights
			options = append(options, sftp.WithServerWorkingDirectory(home))
		}
	}
	server, err := sftp.NewServer(rwc, options...)
	if err != nil {
		return err
	}
	if err := server.Serve(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}
