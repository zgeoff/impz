package sysutil

import (
	"fmt"
	"io/fs"
	"path/filepath"
)

func FindInPath(file, path string, stat func(string) (fs.FileInfo, error)) (string, error) {
	for _, dir := range filepath.SplitList(path) {
		// an empty dir is the current one, as execvp reads it
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
