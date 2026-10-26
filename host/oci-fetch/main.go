package main

import (
	"archive/tar"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/google/go-containerregistry/pkg/authn"
	"github.com/google/go-containerregistry/pkg/name"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/remote"
)

const usage = `usage: oci-fetch config REF
       oci-fetch export REF`

// usageError is a command line that the commands do not accept.
type usageError struct{ reason string }

func (err *usageError) Error() string { return err.reason }

var commands = map[string]func(ref string, out io.Writer) error{
	"config": writeConfig,
	"export": writeExport,
}

func main() {
	os.Exit(runMain(os.Args[1:], os.Stdout, os.Stderr))
}

// runMain runs one command line and returns its exit code: 2 for a usage
// error, 1 for a failed command.
func runMain(args []string, stdout, stderr io.Writer) int {
	err := run(args, stdout)
	var usageErr *usageError
	if errors.As(err, &usageErr) {
		fmt.Fprintf(stderr, "oci-fetch: %v\n%s\n", err, usage)
		return 2
	}
	if err != nil {
		fmt.Fprintf(stderr, "oci-fetch: %v\n", err)
		return 1
	}
	return 0
}

func run(args []string, out io.Writer) error {
	write, ref, err := parseArgs(args)
	if err != nil {
		return err
	}
	return write(ref, out)
}

// parseArgs reads the command's name and its one image ref.
func parseArgs(args []string) (func(ref string, out io.Writer) error, string, error) {
	global := flag.NewFlagSet("oci-fetch", flag.ContinueOnError)
	global.SetOutput(io.Discard)
	if err := global.Parse(args); err != nil {
		return nil, "", &usageError{reason: err.Error()}
	}
	if global.NArg() == 0 {
		return nil, "", &usageError{reason: "no command"}
	}

	name := global.Arg(0)
	write, ok := commands[name]
	if !ok {
		return nil, "", &usageError{reason: fmt.Sprintf("unknown command %q", name)}
	}

	command := flag.NewFlagSet(name, flag.ContinueOnError)
	command.SetOutput(io.Discard)
	if err := command.Parse(global.Args()[1:]); err != nil {
		return nil, "", &usageError{reason: fmt.Sprintf("%s: %v", name, err)}
	}
	if command.NArg() != 1 {
		return nil, "", &usageError{reason: fmt.Sprintf("%s takes one image ref", name)}
	}
	return write, command.Arg(0), nil
}

type imageConfig struct {
	Digest string          `json:"digest"`
	Config json.RawMessage `json:"config"`
}

func writeConfig(ref string, out io.Writer) error {
	img, err := readImage(ref)
	if err != nil {
		return err
	}

	digest, err := img.Digest()
	if err != nil {
		return fmt.Errorf("digest of %s: %w", ref, err)
	}

	file, err := img.ConfigFile()
	if err != nil {
		return fmt.Errorf("config of %s: %w", ref, err)
	}

	config, err := json.Marshal(file.Config)
	if err != nil {
		return err
	}

	return json.NewEncoder(out).Encode(imageConfig{Digest: digest.String(), Config: config})
}

// docker export adds these directories to every container's tree, and the
// guest mounts on them at boot.
var mountDirs = []string{"dev", "proc", "sys"}

func writeExport(ref string, out io.Writer) error {
	img, err := readImage(ref)
	if err != nil {
		return err
	}

	tree := tar.NewWriter(out)
	f, err := flatten(img, tree)
	if err != nil {
		return err
	}

	for _, dir := range mountDirs {
		if f.seen[dir] {
			continue
		}
		header := &tar.Header{Typeflag: tar.TypeDir, Name: dir, Mode: 0o755}
		if err := tree.WriteHeader(header); err != nil {
			return err
		}
	}

	return tree.Close()
}

// A multi-platform ref resolves to the image for the host's own platform,
// the one its imps run.
func readImage(ref string) (v1.Image, error) {
	parsed, err := name.ParseReference(ref)
	if err != nil {
		return nil, err
	}

	img, err := remote.Image(parsed,
		remote.WithAuthFromKeychain(authn.DefaultKeychain),
		remote.WithPlatform(v1.Platform{OS: "linux", Architecture: runtime.GOARCH}),
		remote.WithUserAgent("imp-oci-fetch"),
	)
	if err != nil {
		return nil, fmt.Errorf("fetch %s: %w", ref, err)
	}

	return img, nil
}
