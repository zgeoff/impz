// The layer walk, whiteout handling and path checks come from
// go-containerregistry v0.22.1, pkg/v1/mutate/mutate.go:
//
// Copyright 2018 Google LLC All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//    http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"archive/tar"
	"errors"
	"fmt"
	"io"
	"maps"
	"path"
	"slices"
	"strings"

	v1 "github.com/google/go-containerregistry/pkg/v1"
)

const (
	whiteoutPrefix = ".wh."
	opaqueWhiteout = ".wh..wh..opq"
)

// flattener writes an image's layers, top layer first, as one tree. Hard
// links make the walk keep more than the names it has written: a lower
// layer's link must keep the content its target had in that layer, and an
// upper layer's link must follow its target in the output.
type flattener struct {
	out *tar.Writer

	// fileMap holds every name an upper layer wrote or deleted; true marks a
	// name whose children are hidden as well.
	fileMap map[string]bool
	// opaqueDirs holds directories that an upper layer made opaque.
	opaqueDirs map[string]bool
	// seen holds every written name, rooted and cleaned.
	seen map[string]bool
	// pending holds the links whose target an upper layer replaced, keyed by
	// that target, until a lower layer gives the target's content.
	pending map[string][]*tar.Header
	// deferred holds the links whose target a lower layer writes.
	deferred []*tar.Header
}

// layerState is what one layer's walk knows about its own entries.
type layerState struct {
	// kept holds this layer's entries that the output holds.
	kept map[string]bool
	// shadowed holds this layer's entries that an upper layer hides, each
	// with the name its content is written under, or "" before it is.
	shadowed map[string]string
	// roots maps each of this layer's links to the entry it ends at.
	roots map[string]string
	// orphans holds the surviving links to a shadowed entry whose content
	// the walk has passed, keyed by that entry.
	orphans map[string][]*tar.Header
}

// flatten writes img's tree to out and leaves out open for more entries.
func flatten(img v1.Image, out *tar.Writer) (*flattener, error) {
	layers, err := img.Layers()
	if err != nil {
		return nil, fmt.Errorf("read the image's layers: %w", err)
	}

	f := &flattener{
		out:        out,
		fileMap:    map[string]bool{},
		opaqueDirs: map[string]bool{},
		seen:       map[string]bool{},
		pending:    map[string][]*tar.Header{},
	}

	// Walking from the top layer down lets each deletion hide the lower
	// layers' entries without a second pass.
	for i := len(layers) - 1; i >= 0; i-- {
		if err := f.writeLayer(layers[i]); err != nil {
			return nil, fmt.Errorf("layer %d: %w", i, err)
		}
	}

	// No lower layer holds these targets, so the output's own entry is the
	// best the links can have.
	for _, target := range slices.Sorted(maps.Keys(f.pending)) {
		f.deferred = append(f.deferred, f.pending[target]...)
	}
	for _, link := range f.deferred {
		if err := f.write(link, nil); err != nil {
			return nil, err
		}
	}

	return f, nil
}

func (f *flattener) writeLayer(layer v1.Layer) error {
	state := &layerState{
		kept:     map[string]bool{},
		shadowed: map[string]string{},
		roots:    map[string]string{},
		orphans:  map[string][]*tar.Header{},
	}
	// An opaque marker hides only the layers below its own.
	layerOpaque := map[string]bool{}

	reader, err := layer.Uncompressed()
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	defer reader.Close()

	entries := tar.NewReader(reader)
	for {
		header, err := entries.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		// Some tools prefix every name with "./".
		header.Name = path.Clean(header.Name)
		if unsafeArchivePath(header.Name) {
			return fmt.Errorf("unsafe tar path %q", header.Name)
		}
		if header.Typeflag == tar.TypeSymlink || header.Typeflag == tar.TypeLink {
			if unsafeRelativeLink(header.Name, header.Linkname) {
				continue
			}
		}
		if header.Typeflag == tar.TypeLink {
			header.Linkname = path.Clean(header.Linkname)
		}
		// PAX lifts USTAR's 100-character limit on names and link targets.
		header.Format = tar.FormatPAX

		basename := path.Base(header.Name)
		dirname := path.Dir(header.Name)

		if basename == opaqueWhiteout {
			layerOpaque[dirname] = true
			continue
		}

		tombstone := strings.HasPrefix(basename, whiteoutPrefix)
		if tombstone {
			basename = basename[len(whiteoutPrefix):]
		}

		name := header.Name
		if header.Typeflag != tar.TypeDir {
			name = path.Join(dirname, basename)
		}

		_, written := f.fileMap[name]
		if (written && !tombstone) || inWhiteoutDir(f.fileMap, name) || inOpaqueDir(f.opaqueDirs, name) {
			if err := f.shadow(state, header, name, tombstone, entries); err != nil {
				return err
			}
			continue
		}

		// A name that is not a directory hides its children too.
		f.fileMap[name] = tombstone || header.Typeflag != tar.TypeDir
		if tombstone {
			continue
		}

		if header.Typeflag == tar.TypeLink {
			root := state.root(header.Linkname)
			state.roots[name] = root
			if err := f.placeLink(state, header, root); err != nil {
				return err
			}
			continue
		}

		if err := f.write(header, entries); err != nil {
			return err
		}
		if header.Typeflag != tar.TypeDir {
			state.kept[name] = true
		}
	}

	for dir := range layerOpaque {
		f.opaqueDirs[dir] = true
	}

	// The verifying reader checks the layer's digest only once it reaches
	// io.EOF, past any bytes after the tar's end.
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return fmt.Errorf("verify: %w", err)
	}

	if len(state.orphans) == 0 {
		return nil
	}
	return f.writeOrphans(layer, state)
}

// shadow records an entry that an upper layer hides, and gives its content
// to the upper layers' links that wait for it.
func (f *flattener) shadow(state *layerState, header *tar.Header, name string, tombstone bool, content io.Reader) error {
	if tombstone || header.Typeflag == tar.TypeDir || state.has(name) {
		return nil
	}

	links := f.pending[name]
	delete(f.pending, name)

	if header.Typeflag == tar.TypeLink {
		root := state.root(header.Linkname)
		state.roots[name] = root
		for _, link := range links {
			if err := f.placeLink(state, link, root); err != nil {
				return err
			}
		}
		return nil
	}

	state.shadowed[name] = ""
	if len(links) == 0 {
		return nil
	}
	return f.writeShadowed(state, header, name, content, links)
}

// placeLink writes a surviving link to root, or holds it until root's
// content is in the output.
func (f *flattener) placeLink(state *layerState, link *tar.Header, root string) error {
	link.Linkname = root

	if written, ok := state.shadowed[root]; ok {
		if written == "" {
			state.orphans[root] = append(state.orphans[root], link)
			return nil
		}
		link.Linkname = written
		return f.write(link, nil)
	}

	if state.kept[root] {
		return f.write(link, nil)
	}

	_, replaced := f.fileMap[root]
	if replaced || inWhiteoutDir(f.fileMap, root) || inOpaqueDir(f.opaqueDirs, root) {
		f.pending[root] = append(f.pending[root], link)
		return nil
	}

	f.deferred = append(f.deferred, link)
	return nil
}

// writeShadowed writes a shadowed entry's content under its first link's
// name, and links the rest to that name.
func (f *flattener) writeShadowed(state *layerState, entry *tar.Header, name string, content io.Reader, links []*tar.Header) error {
	first := *entry
	first.Name = links[0].Name
	if err := f.write(&first, content); err != nil {
		return err
	}
	state.shadowed[name] = first.Name

	for _, link := range links[1:] {
		link.Linkname = first.Name
		if err := f.write(link, nil); err != nil {
			return err
		}
	}
	return nil
}

// writeOrphans reads the layer again for the content of the shadowed
// entries that its own links need.
func (f *flattener) writeOrphans(layer v1.Layer, state *layerState) error {
	reader, err := layer.Uncompressed()
	if err != nil {
		return fmt.Errorf("read again: %w", err)
	}
	defer reader.Close()

	entries := tar.NewReader(reader)
	for len(state.orphans) > 0 {
		header, err := entries.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read again: %w", err)
		}

		name := path.Clean(header.Name)
		links, ok := state.orphans[name]
		if !ok || header.Typeflag == tar.TypeLink || header.Typeflag == tar.TypeDir {
			continue
		}
		delete(state.orphans, name)

		header.Name = name
		header.Format = tar.FormatPAX
		if err := f.writeShadowed(state, header, name, entries, links); err != nil {
			return err
		}
	}

	if len(state.orphans) > 0 {
		return errors.New("the layer changed between two reads")
	}

	if _, err := io.Copy(io.Discard, reader); err != nil {
		return fmt.Errorf("verify: %w", err)
	}
	return nil
}

// write writes one entry, with content's bytes for an entry that has them.
func (f *flattener) write(header *tar.Header, content io.Reader) error {
	if err := f.out.WriteHeader(header); err != nil {
		return err
	}
	f.seen[path.Clean(strings.TrimPrefix(header.Name, "/"))] = true

	if content == nil || header.Size <= 0 {
		return nil
	}
	_, err := io.CopyN(f.out, content, header.Size)
	return err
}

func (state *layerState) has(name string) bool {
	_, shadowed := state.shadowed[name]
	_, linked := state.roots[name]
	return shadowed || linked || state.kept[name]
}

// root follows this layer's links from target to the entry they end at.
func (state *layerState) root(target string) string {
	if root, ok := state.roots[target]; ok {
		return root
	}
	return target
}

func inOpaqueDir(opaqueDirs map[string]bool, file string) bool {
	for file != "" {
		dirname := path.Dir(file)
		if file == dirname {
			break
		}
		if opaqueDirs[dirname] {
			return true
		}
		file = dirname
	}
	return false
}

func inWhiteoutDir(fileMap map[string]bool, file string) bool {
	for file != "" {
		dirname := path.Dir(file)
		if file == dirname {
			break
		}
		if val, ok := fileMap[dirname]; ok && val {
			return true
		}
		file = dirname
	}
	return false
}

func unsafeArchivePath(name string) bool {
	clean := cleanArchivePath(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return true
	}
	if strings.HasPrefix(name, "\\") {
		return true
	}
	return hasWindowsDrivePrefix(clean)
}

// unsafeRelativeLink reports a relative link whose target, resolved from the
// link's own directory, leaves the tree.
func unsafeRelativeLink(name, linkname string) bool {
	clean := cleanArchivePath(linkname)
	if path.IsAbs(clean) {
		return false
	}
	if hasWindowsDrivePrefix(clean) {
		return true
	}
	resolved := path.Clean(path.Join(path.Dir(name), clean))
	return strings.HasPrefix(resolved, "..")
}

func cleanArchivePath(name string) string {
	return path.Clean(strings.ReplaceAll(name, "\\", "/"))
}

func hasWindowsDrivePrefix(name string) bool {
	return len(name) >= 2 &&
		(('A' <= name[0] && name[0] <= 'Z') || ('a' <= name[0] && name[0] <= 'z')) &&
		name[1] == ':'
}
