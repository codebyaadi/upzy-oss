package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/projectdiscovery/nuclei/v3/pkg/model"
	"github.com/projectdiscovery/nuclei/v3/pkg/model/types/severity"
	"github.com/projectdiscovery/nuclei/v3/pkg/output"
)

func event(id, name, matched string, meta map[string]any) *output.ResultEvent {
	ev := &output.ResultEvent{TemplateID: id, Matched: matched, Response: "SECRET=hunter2", ExtractedResults: []string{"hunter2"}}
	ev.Info = model.Info{Name: name, Metadata: meta}
	ev.Info.SeverityHolder.Severity = severity.High
	return ev
}

func TestMapEventUsesOurKeyAndSubject(t *testing.T) {
	f, ok := MapEvent(event("upzy-exposure-env", "Env file", "https://x.test/.env?token=abc", map[string]any{
		metaCheckKey: "exposure.path", metaSubject: "/.env",
	}))
	if !ok || f.CheckKey != "exposure.path" || f.Subject != "/.env" || f.Severity != "high" {
		t.Fatalf("got %+v ok=%v", f, ok)
	}
}

func TestMapEventForOtherTemplates(t *testing.T) {
	f, ok := MapEvent(event("Laravel-Env", "Laravel env", "https://x.test/.env.bak?a=b", nil))
	if !ok || f.CheckKey != "nuclei.laravel_env" || f.Subject != "/.env.bak" {
		t.Fatalf("got %+v", f)
	}
	if f.Remediation == "" || f.Description == "" {
		t.Fatal("a finding needs advice and a description")
	}
	if _, ok := MapEvent(nil); ok {
		t.Fatal("nil event")
	}
}

func TestEvidenceNeverCarriesWhatWasRead(t *testing.T) {
	f, _ := MapEvent(event("x", "x", "https://x.test/a?token=abc", nil))
	b, _ := json.Marshal(f)
	for _, bad := range []string{"hunter2", "token=abc", "SECRET"} {
		if strings.Contains(string(b), bad) {
			t.Fatalf("finding leaks %q: %s", bad, b)
		}
	}
}

func TestTemplateSetIsStableAndComplete(t *testing.T) {
	dir, id, n, err := TemplateSet()
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	_, id2, n2, err := TemplateSet()
	if err != nil || id != id2 || n != n2 {
		t.Fatalf("set changed between runs: %s/%d vs %s/%d (%v)", id, n, id2, n2, err)
	}
	if n < 30 {
		t.Fatalf("only %d templates", n)
	}
	files, _ := filepath.Glob(filepath.Join(dir, "*", "*.yaml"))
	if len(files) != n {
		t.Fatalf("extracted %d of %d", len(files), n)
	}
}

// Nothing in the set may carry a tag the engine would refuse anyway, or use a protocol other than http.
func TestTemplatesAreNonIntrusive(t *testing.T) {
	banned := map[string]bool{}
	for _, tag := range excludedTags {
		banned[tag] = true
	}
	tagsRe := regexp.MustCompile(`(?m)^\s*tags:\s*(.+)$`)
	files, _ := filepath.Glob("templates/*/*.yaml")
	for _, f := range files {
		b, _ := os.ReadFile(f)
		for _, m := range tagsRe.FindAllStringSubmatch(string(b), -1) {
			for _, tag := range strings.Split(m[1], ",") {
				if banned[strings.TrimSpace(tag)] {
					t.Errorf("%s carries excluded tag %q", f, tag)
				}
			}
		}
		for _, p := range []string{"\ntcp:", "\ndns:", "\nheadless:", "\nfile:", "\ncode:", "\njavascript:", "\nssl:", "\nwhois:"} {
			if strings.Contains(string(b), p) {
				t.Errorf("%s uses protocol %q", f, strings.TrimSpace(p))
			}
		}
	}
}

func TestEngineVersionMatchesGoMod(t *testing.T) {
	b, _ := os.ReadFile("go.mod")
	if !strings.Contains(string(b), "github.com/projectdiscovery/nuclei/v3 "+engineVersion) {
		t.Fatalf("engineVersion %s is not the version in go.mod", engineVersion)
	}
}

func TestGuardBlocksPrivateTargets(t *testing.T) {
	for _, h := range []string{"127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1", "localhost", "2130706433", "0x7f.1", "[::ffff:10.0.0.1]", "foo.localhost"} {
		if _, err := ResolvePublic(context.Background(), h); err == nil {
			t.Errorf("%s should be refused", h)
		}
	}
	if a, err := ResolvePublic(context.Background(), "93.184.216.34"); err != nil || a.String() != "93.184.216.34" {
		t.Errorf("public address refused: %v", err)
	}
}

func TestRunRefusesPrivateTargetBeforeSendingAnything(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	s := &Scanner{TemplateDir: t.TempDir(), SetID: "t"}
	res := s.Run(context.Background(), Job{Host: "127.0.0.1", URL: srv.URL, RateLimitPerSecond: 5, TimeoutSeconds: 30})
	if !strings.HasPrefix(res.Error, "Refused") || hits.Load() != 0 {
		t.Fatalf("error=%q hits=%d", res.Error, hits.Load())
	}
}

func TestRunFindsAnExposedFileAndStaysWithinTheRateLimit(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/.git/HEAD" {
			w.Write([]byte("ref: refs/heads/main\n"))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	dir, id, _, err := TemplateSet()
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)

	s := &Scanner{TemplateDir: dir, SetID: id, allowLocal: true}
	start := time.Now()
	res := s.Run(context.Background(), Job{Host: "127.0.0.1", URL: srv.URL + "/", RateLimitPerSecond: 20, TimeoutSeconds: 120})
	if res.Error != "" {
		t.Fatalf("error: %s", res.Error)
	}
	var got *Finding
	for i := range res.Findings {
		if res.Findings[i].Subject == "/.git/HEAD" {
			got = &res.Findings[i]
		}
	}
	if got == nil || got.CheckKey != "exposure.path" {
		t.Fatalf("expected the builtin-shaped exposure finding, got %+v", res.Findings)
	}
	p := res.Provenance
	if p.TemplatesRun < 30 || p.Engine != "nuclei" || p.TemplateSet != id || len(p.Templates) != p.TemplatesRun {
		t.Fatalf("provenance %+v", p)
	}
	// With 20 requests a second, N requests cannot finish faster than (N-1)/20 seconds, whatever the concurrency.
	n := int(hits.Load())
	if min := time.Duration(n-1) * time.Second / 20; time.Since(start) < min/2 {
		t.Fatalf("%d requests in %s is faster than the rate limit allows", n, time.Since(start))
	}
}

func TestWorkerPullsScansAndReports(t *testing.T) {
	var reported atomic.Int32
	var lastBody atomic.Value
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "/hello"):
			w.Write([]byte(`{"scanner":"s","protocol":1,"pollSeconds":1}`))
		case strings.HasSuffix(r.URL.Path, "/jobs/pull"):
			if reported.Load() == 0 {
				w.Write([]byte(`{"jobs":[{"jobId":"j1","assetId":"a1","host":"127.0.0.1","url":"http://127.0.0.1:1/","rateLimitPerSecond":5,"timeoutSeconds":30}]}`))
				return
			}
			w.Write([]byte(`{"jobs":[]}`))
		case strings.HasSuffix(r.URL.Path, "/result"):
			var b map[string]any
			json.NewDecoder(r.Body).Decode(&b)
			lastBody.Store(b)
			reported.Add(1)
			w.WriteHeader(202)
			w.Write([]byte(`{"accepted":true}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer api.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	w := &Worker{client: NewClient(api.URL, "tok"), scanner: &Scanner{TemplateDir: t.TempDir(), SetID: "t"}, logf: t.Logf, poll: time.Second}
	done := make(chan error, 1)
	go func() { done <- w.Run(ctx) }()
	for reported.Load() == 0 && ctx.Err() == nil {
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	<-done
	b, _ := lastBody.Load().(map[string]any)
	// The target was a loopback address, so the scanner refused it and said so rather than scanning.
	if reported.Load() != 1 || !strings.HasPrefix(b["error"].(string), "Refused") {
		t.Fatalf("reported=%d body=%v", reported.Load(), b)
	}
}

func TestWorkerStopsOnARefusedToken(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) }))
	defer api.Close()
	w := &Worker{client: NewClient(api.URL, "bad"), scanner: &Scanner{}, logf: t.Logf, poll: time.Second}
	if err := w.Run(context.Background()); err == nil {
		t.Fatal("expected the worker to stop")
	}
}
