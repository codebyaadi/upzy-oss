package main

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// The curated template set travels inside the binary, so what the scanner can send to a site is fixed when it is built
// and reviewable in this repository: templates/upzy (generated from the built-in exposed-path list, so the two engines
// look for the same files) and templates/upstream (a handful of ProjectDiscovery's MIT-licensed nuclei-templates,
// pinned to one commit: see templates/UPSTREAM.md). Nothing is downloaded at run time.
//
//go:embed templates/upzy/*.yaml templates/upstream/*.yaml templates/UPSTREAM.md
var embedded embed.FS

// TemplateSet extracts the templates to a new directory and returns it, an id for the provenance log (a hash of every
// template, so the log says exactly which set ran), and how many templates there are.
func TemplateSet() (dir, id string, count int, err error) {
	dir, err = os.MkdirTemp("", "upzy-scan-templates-")
	if err != nil {
		return "", "", 0, err
	}
	var names []string
	err = fs.WalkDir(embedded, "templates", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(p, ".yaml") {
			return err
		}
		names = append(names, p)
		return nil
	})
	if err != nil {
		return "", "", 0, err
	}
	sort.Strings(names)
	h := sha256.New()
	for _, n := range names {
		b, err := embedded.ReadFile(n)
		if err != nil {
			return "", "", 0, err
		}
		h.Write([]byte(n))
		h.Write(b)
		dst := filepath.Join(dir, filepath.FromSlash(strings.TrimPrefix(n, "templates/")))
		if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
			return "", "", 0, err
		}
		if err := os.WriteFile(dst, b, 0o600); err != nil {
			return "", "", 0, err
		}
	}
	return dir, "set-" + hex.EncodeToString(h.Sum(nil))[:12], len(names), nil
}
