package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/google/go-containerregistry/pkg/name"
	"github.com/google/go-containerregistry/pkg/registry"
	v1 "github.com/google/go-containerregistry/pkg/v1"
	"github.com/google/go-containerregistry/pkg/v1/empty"
	"github.com/google/go-containerregistry/pkg/v1/mutate"
	"github.com/google/go-containerregistry/pkg/v1/remote"
	"github.com/google/go-containerregistry/pkg/v1/tarball"
	"gotest.tools/v3/assert"
)

type entry struct {
	name     string
	typeflag byte
	body     string
}

func startRegistry(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(registry.New(registry.Logger(log.New(io.Discard, "", 0))))
	t.Cleanup(server.Close)
	return strings.TrimPrefix(server.URL, "http://")
}

func buildLayer(t *testing.T, entries []entry) v1.Layer {
	t.Helper()
	var buffer bytes.Buffer
	writer := tar.NewWriter(&buffer)
	for _, item := range entries {
		header := &tar.Header{Name: item.name, Typeflag: item.typeflag, Mode: 0o644, Size: int64(len(item.body))}
		if item.typeflag == tar.TypeDir {
			header.Mode = 0o755
		}
		assert.NilError(t, writer.WriteHeader(header))
		_, err := writer.Write([]byte(item.body))
		assert.NilError(t, err)
	}
	assert.NilError(t, writer.Close())
	layer, err := tarball.LayerFromOpener(func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(buffer.Bytes())), nil
	})
	assert.NilError(t, err)
	return layer
}

func buildImage(t *testing.T, env []string, layers ...v1.Layer) v1.Image {
	t.Helper()
	img, err := mutate.AppendLayers(empty.Image, layers...)
	assert.NilError(t, err)
	img, err = mutate.Config(img, v1.Config{Env: env})
	assert.NilError(t, err)
	return img
}

func pushImage(t *testing.T, host string, img v1.Image) string {
	t.Helper()
	digest, err := img.Digest()
	assert.NilError(t, err)
	ref, err := name.ParseReference(host + "/builder@" + digest.String())
	assert.NilError(t, err)
	assert.NilError(t, remote.Write(ref, img))
	return ref.String()
}

func readTree(t *testing.T, archive []byte) map[string]string {
	t.Helper()
	tree := map[string]string{}
	reader := tar.NewReader(bytes.NewReader(archive))
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return tree
		}
		assert.NilError(t, err)
		body, err := io.ReadAll(reader)
		assert.NilError(t, err)
		_, isListed := tree[header.Name]
		assert.Assert(t, !isListed, "%s is in the export twice", header.Name)
		tree[header.Name] = string(body)
	}
}

func TestExportWritesTheFlattenedTreeWithoutWhiteouts(t *testing.T) {
	host := startRegistry(t)
	ref := pushImage(t, host, buildImage(t, nil,
		buildLayer(t, []entry{
			{name: "dev/", typeflag: tar.TypeDir},
			{name: "srv/", typeflag: tar.TypeDir},
			{name: "srv/gone", typeflag: tar.TypeReg, body: "old\n"},
			{name: "srv/kept", typeflag: tar.TypeReg, body: "kept\n"},
		}),
		buildLayer(t, []entry{
			{name: "srv/.wh.gone", typeflag: tar.TypeReg},
			{name: "srv/kept", typeflag: tar.TypeReg, body: "replaced\n"},
		}),
	))
	var out bytes.Buffer

	assert.NilError(t, run("export", ref, &out))

	assert.DeepEqual(t, readTree(t, out.Bytes()), map[string]string{
		"dev":      "",
		"srv":      "",
		"srv/kept": "replaced\n",
		"proc":     "",
		"sys":      "",
	})
}

func TestConfigPrintsTheImageDigestAndItsRuntimeConfig(t *testing.T) {
	host := startRegistry(t)
	img := buildImage(t, []string{"PATH=/usr/bin"}, buildLayer(t, []entry{{name: "srv/", typeflag: tar.TypeDir}}))
	ref := pushImage(t, host, img)
	digest, err := img.Digest()
	assert.NilError(t, err)
	var out bytes.Buffer

	assert.NilError(t, run("config", ref, &out))

	var printed struct {
		Digest string
		Config struct{ Env []string }
	}
	assert.NilError(t, json.Unmarshal(out.Bytes(), &printed))
	assert.Equal(t, printed.Digest, digest.String())
	assert.DeepEqual(t, printed.Config.Env, []string{"PATH=/usr/bin"})
}

func TestExportPicksTheHostPlatformFromAMultiPlatformRef(t *testing.T) {
	host := startRegistry(t)
	own := buildImage(t, nil, buildLayer(t, []entry{{name: "own", typeflag: tar.TypeReg, body: "own\n"}}))
	other := buildImage(t, nil, buildLayer(t, []entry{{name: "other", typeflag: tar.TypeReg, body: "other\n"}}))
	index := mutate.AppendManifests(empty.Index,
		mutate.IndexAddendum{Add: other, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: "not-" + runtime.GOARCH}}},
		mutate.IndexAddendum{Add: own, Descriptor: v1.Descriptor{Platform: &v1.Platform{OS: "linux", Architecture: runtime.GOARCH}}},
	)
	digest, err := index.Digest()
	assert.NilError(t, err)
	ref, err := name.ParseReference(host + "/builder@" + digest.String())
	assert.NilError(t, err)
	assert.NilError(t, remote.WriteIndex(ref, index))
	var out bytes.Buffer

	assert.NilError(t, run("export", ref.String(), &out))

	assert.DeepEqual(t, readTree(t, out.Bytes()), map[string]string{
		"own":  "own\n",
		"dev":  "",
		"proc": "",
		"sys":  "",
	})
}

func TestFetchOfAnImageTheRegistryLacksFails(t *testing.T) {
	host := startRegistry(t)
	var out bytes.Buffer

	err := run("config", host+"/builder@sha256:"+strings.Repeat("a", 64), &out)

	assert.ErrorContains(t, err, "fetch "+host+"/builder@sha256:")
}

func TestAnUnknownCommandFails(t *testing.T) {
	var out bytes.Buffer

	err := run("pull", "alpine", &out)

	assert.ErrorContains(t, err, `unknown command "pull"`)
}
