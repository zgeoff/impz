package sysutil

import (
	"fmt"
	"io/fs"
	"path/filepath"
)

// FindInPath finds file in the dirs of path, a PATH value, through stat: the
// first that is no directory and has an execute bit wins. An empty dir is the
// current one, as execvp reads it.
func FindInPath(file, path string, stat func(string) (fs.FileInfo, error)) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		if dir == "" {
			dir = "."
		}
		p := filepath.Join(dir, file)
		if CheckExecutable(p, stat) == nil {
			return p, nil
		}
	}
	return "", fmt.Errorf("%s: executable file not found in $PATH", file)
}

// CheckExecutable reports why p, as stat sees it, is no file to run.
func CheckExecutable(p string, stat func(string) (fs.FileInfo, error)) error {
	fi, err := stat(p)
	if err != nil {
		return err
	}
	if fi.IsDir() || fi.Mode()&0o111 == 0 {
		return fmt.Errorf("%s: permission denied", p)
	}
	return nil
}
