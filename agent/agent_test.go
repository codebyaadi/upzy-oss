package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeAPI is the server side of the agent protocol, as far as the agent can tell.
type fakeAPI struct {
	mu       sync.Mutex
	jobs     []Job
	results  map[string]Result
	hellos   int
	rejected string // a token the server refuses
}

func (f *fakeAPI) handler() http.Handler {
	mux := http.NewServeMux()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer upzy_agent_good" {
				http.Error(w, `{"error":"Invalid or revoked agent token."}`, 401)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("/agent/hello", auth(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.hellos++
		f.mu.Unlock()
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		if in["version"] == nil || in["os"] == nil {
			http.Error(w, "bad hello", 400)
			return
		}
		_, _ = w.Write([]byte(`{"agent":"test","region":"eu-west","protocol":1,"pollSeconds":1}`))
	}))
	mux.HandleFunc("/agent/jobs/pull", auth(func(w http.ResponseWriter, _ *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		out := f.jobs
		f.jobs = nil
		_ = json.NewEncoder(w).Encode(map[string]any{"jobs": out})
	}))
	mux.HandleFunc("/agent/jobs/", auth(func(w http.ResponseWriter, r *http.Request) {
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/agent/jobs/"), "/result")
		var res Result
		if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
			http.Error(w, "bad", 400)
			return
		}
		f.mu.Lock()
		f.results[id] = res
		f.mu.Unlock()
		w.WriteHeader(202)
		_, _ = w.Write([]byte(`{"accepted":true}`))
	}))
	return mux
}

func TestAgentRunsAChargedCheckEndToEnd(t *testing.T) {
	allowLoopback(t)
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hello from the site")) }))
	defer site.Close()
	f := &fakeAPI{results: map[string]Result{}}
	f.jobs = []Job{
		{JobID: "11111111-1111-4111-8111-111111111111", MonitorID: "m1", Type: "http", Target: site.URL, Config: json.RawMessage(`{"keyword":"hello"}`)},
		{JobID: "22222222-2222-4222-8222-222222222222", MonitorID: "m2", Type: "http", Target: "http://169.254.169.254/", Config: json.RawMessage(`{}`)},
	}
	api := httptest.NewServer(f.handler())
	defer api.Close()

	a := &Agent{client: NewClient(api.URL, "upzy_agent_good"), concurrency: 4, run: RunProbe, logf: t.Logf, pollEvery: 50 * time.Millisecond}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx, 5*time.Second) }()

	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		n := len(f.results)
		f.mu.Unlock()
		if n == 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	if r := f.results["11111111-1111-4111-8111-111111111111"]; r.Status != "up" || r.ResponseMs == nil {
		t.Fatalf("the reachable site: %+v", r)
	}
	if r := f.results["22222222-2222-4222-8222-222222222222"]; r.Status != "down" || r.ErrorKind != "blocked" {
		t.Fatalf("the metadata address must be refused and reported as such: %+v", r)
	}
	if f.hellos != 1 {
		t.Fatalf("hello once, got %d", f.hellos)
	}
}

func TestAgentStopsWhenTheTokenIsRefused(t *testing.T) {
	f := &fakeAPI{results: map[string]Result{}}
	api := httptest.NewServer(f.handler())
	defer api.Close()
	a := &Agent{client: NewClient(api.URL, "upzy_agent_revoked"), concurrency: 1, run: RunProbe, logf: t.Logf, pollEvery: time.Second}
	err := a.Run(context.Background(), time.Second)
	if err == nil || !strings.Contains(err.Error(), "refused") {
		t.Fatalf("a revoked token ends the agent with a clear message, got %v", err)
	}
}

func TestResultJSONMatchesTheContract(t *testing.T) {
	b, _ := json.Marshal(Result{Status: "down", ResponseMs: nil, Error: "x", ErrorKind: "timeout"})
	if string(b) != `{"status":"down","responseMs":null,"error":"x","errorKind":"timeout"}` {
		t.Fatalf("responseMs must be present (null) and optional fields omitted: %s", b)
	}
	up, _ := json.Marshal(Result{Status: "up", ResponseMs: ptr(12), TLSDaysLeft: ptr(40)})
	if string(up) != `{"status":"up","responseMs":12,"tlsDaysLeft":40}` {
		t.Fatalf("%s", up)
	}
}
