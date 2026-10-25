package main

import (
	"archive/tar"
	"encoding/json"
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

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, usage)
		os.Exit(2)
	}

	err := run(os.Args[1], os.Args[2], os.Stdout)
	if err != nil {
		fmt.Fprintf(os.Stderr, "oci-fetch: %v\n", err)
		os.Exit(1)
	}
}

func run(command, ref string, out io.Writer) error {
	switch command {
	case "config":
		return writeConfig(ref, out)
	case "export":
		return writeExport(ref, out)
	default:
		return fmt.Errorf("unknown command %q\n%s", command, usage)
	}
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
