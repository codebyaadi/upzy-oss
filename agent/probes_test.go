package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// allowLoopback lets a test reach its own httptest server, the way a public address would be reachable in production.
func allowLoopback(t *testing.T) {
	t.Helper()
	testAllow = func(ip string) bool { return ip == "127.0.0.1" }
	t.Cleanup(func() { testAllow = nil })
}

func job(typ, target string, cfg any, secrets map[string]string) Job {
	raw, _ := json.Marshal(cfg)
	return Job{JobID: "j", MonitorID: "m", Type: typ, Target: target, Config: raw, Secrets: secrets}
}

func TestHTTPProbe(t *testing.T) {
	allowLoopback(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/ok", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"status":"green","n":7}`)) })
	mux.HandleFunc("/teapot", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(418) })
	mux.HandleFunc("/echo-auth", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.Header.Get("Authorization")))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	cases := []struct {
		name       string
		path       string
		cfg        map[string]any
		wantStatus string
		wantKind   string
		wantInErr  string
	}{
		{"up", "/ok", map[string]any{}, "up", "", ""},
		{"unexpected status", "/teapot", map[string]any{}, "down", "http", "Unexpected status 418"},
		{"expected status accepted", "/teapot", map[string]any{"expectedStatus": []int{418}}, "up", "", ""},
		{"keyword found", "/ok", map[string]any{"keyword": "green"}, "up", "", ""},
		{"keyword missing", "/ok", map[string]any{"keyword": "blue"}, "down", "http", "Expected keyword not found"},
		{"assertion passes", "/ok", map[string]any{"assertions": []Assertion{{Path: "status", Op: "equals", Value: "green"}, {Path: "n", Op: "gt", Value: "5"}}}, "up", "", ""},
		{"assertion fails with the same words as the server's prober", "/ok", map[string]any{"assertions": []Assertion{{Path: "status", Op: "equals", Value: "red"}}}, "down", "assertion", "Expected status to equal red, but it is green"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := RunProbe(context.Background(), job("http", srv.URL+c.path, c.cfg, nil))
			if r.Status != c.wantStatus || r.ErrorKind != c.wantKind || !strings.Contains(r.Error, c.wantInErr) {
				t.Fatalf("got %+v", r)
			}
			if r.ResponseMs == nil || r.StatusCode == nil {
				t.Fatalf("timings and status code are reported: %+v", r)
			}
		})
	}

	t.Run("secrets are filled in and never come back in an error", func(t *testing.T) {
		cfg := map[string]any{"headers": map[string]string{"Authorization": "Bearer {{secret.TOKEN}}"}, "keyword": "nope"}
		r := RunProbe(context.Background(), job("http", srv.URL+"/echo-auth", cfg, map[string]string{"TOKEN": "s3cr3t-value"}))
		if r.Status != "down" || strings.Contains(r.Error, "s3cr3t-value") {
			t.Fatalf("%+v", r)
		}
		ok := RunProbe(context.Background(), job("http", srv.URL+"/echo-auth",
			map[string]any{"headers": map[string]string{"Authorization": "Bearer {{secret.TOKEN}}"}, "keyword": "Bearer s3cr3t-value"},
			map[string]string{"TOKEN": "s3cr3t-value"}))
		if ok.Status != "up" {
			t.Fatalf("the secret reached the request: %+v", ok)
		}
	})

	t.Run("an unknown secret fails loudly instead of sending the placeholder", func(t *testing.T) {
		r := RunProbe(context.Background(), job("http", srv.URL+"/ok", map[string]any{"headers": map[string]string{"X": "{{secret.MISSING}}"}}, nil))
		if r.Status != "down" || !strings.Contains(r.Error, "{{secret.MISSING}} has no value") {
			t.Fatalf("%+v", r)
		}
	})

	t.Run("a slow answer is a timeout", func(t *testing.T) {
		slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { time.Sleep(600 * time.Millisecond) }))
		defer slow.Close()
		r := RunProbe(context.Background(), job("http", slow.URL, map[string]any{"timeoutMs": 150}, nil))
		if r.Status != "down" || r.ErrorKind != "timeout" {
			t.Fatalf("%+v", r)
		}
	})
}

func TestBlockedTargetsAreReportedNotCrashed(t *testing.T) {
	testAllow = nil
	for _, j := range []Job{
		job("http", "http://169.254.169.254/latest/meta-data", map[string]any{}, nil),
		job("http", "http://2130706433/", map[string]any{}, nil),
		job("tcp", "127.0.0.1:5432", map[string]any{}, nil),
		job("ssl", "localhost", map[string]any{}, nil),
		job("flow", "x", map[string]any{"steps": []map[string]any{{"name": "a", "method": "GET", "url": "http://10.0.0.5/", "headers": map[string]string{}, "assertions": []any{}, "extract": map[string]string{}}}}, nil),
	} {
		r := RunProbe(context.Background(), j)
		if r.Status != "down" || r.ErrorKind != "blocked" {
			t.Errorf("%s %s: %+v", j.Type, j.Target, r)
		}
	}
}

func TestTCPProbe(t *testing.T) {
	allowLoopback(t)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			_ = c.Close()
		}
	}()
	if r := RunProbe(context.Background(), job("tcp", l.Addr().String(), map[string]any{}, nil)); r.Status != "up" {
		t.Fatalf("%+v", r)
	}
	l.Close()
	if r := RunProbe(context.Background(), job("tcp", l.Addr().String(), map[string]any{"timeoutMs": 500}, nil)); r.Status != "down" || r.ErrorKind != "refused" {
		t.Fatalf("a closed port is refused: %+v", r)
	}
	if r := RunProbe(context.Background(), job("tcp", "no-port", map[string]any{}, nil)); r.Status != "down" {
		t.Fatalf("%+v", r)
	}
}

func TestFlowProbe(t *testing.T) {
	allowLoopback(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		b := new(strings.Builder)
		buf := make([]byte, 200)
		n, _ := r.Body.Read(buf)
		b.Write(buf[:n])
		if !strings.Contains(b.String(), "hunter2-secret") {
			w.WriteHeader(401)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"token":"tok-123456"}}`))
	})
	mux.HandleFunc("/me", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok-123456" {
			w.WriteHeader(403)
			return
		}
		_, _ = w.Write([]byte(`{"name":"ada"}`))
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	steps := func(me string) map[string]any {
		return map[string]any{"steps": []map[string]any{
			{"name": "log in", "method": "POST", "url": srv.URL + "/login", "headers": map[string]string{}, "body": `{"password":"{{secret.PW}}"}`,
				"assertions": []any{}, "extract": map[string]string{"token": "data.token"}},
			{"name": "who am i", "method": "GET", "url": srv.URL + me, "headers": map[string]string{"Authorization": "Bearer {{token}}"},
				"assertions": []Assertion{{Path: "name", Op: "equals", Value: "ada"}}, "extract": map[string]string{}},
		}}
	}
	secrets := map[string]string{"PW": "hunter2-secret"}

	if r := RunProbe(context.Background(), job("flow", "x", steps("/me"), secrets)); r.Status != "up" || r.StatusCode == nil || *r.StatusCode != 200 {
		t.Fatalf("a value read from step 1 reaches step 2: %+v", r)
	}
	r := RunProbe(context.Background(), job("flow", "x", steps("/nope"), secrets))
	if r.Status != "down" || !strings.HasPrefix(r.Error, "Step 2 (who am i)") {
		t.Fatalf("the failing step names itself: %+v", r)
	}
	r = RunProbe(context.Background(), job("flow", "x", steps("/me"), map[string]string{"PW": "wrong-password"}))
	if r.Status != "down" || !strings.HasPrefix(r.Error, "Step 1 (log in): unexpected status 401") {
		t.Fatalf("%+v", r)
	}
	if strings.Contains(r.Error, "wrong-password") {
		t.Fatal("a secret leaked into the error")
	}
}

func TestDNSAndUnknownType(t *testing.T) {
	if r := RunProbe(context.Background(), job("dns", "no-such-host.invalid", map[string]any{"timeoutMs": 3000}, nil)); r.Status != "down" || r.ErrorKind != "dns" {
		t.Fatalf("%+v", r)
	}
	if r := RunProbe(context.Background(), job("synthetic", "x", map[string]any{}, nil)); r.Status != "down" || r.ErrorKind != "other" {
		t.Fatalf("%+v", r)
	}
	if r := RunProbe(context.Background(), Job{Type: "http", Target: "http://x/", Config: json.RawMessage(`{"timeoutMs": "soon"}`)}); r.Status != "down" {
		t.Fatalf("a config the agent cannot read is reported, not ignored: %+v", r)
	}
}

func TestAssertionMessagesMatchTheServer(t *testing.T) {
	cases := []struct {
		body string
		a    Assertion
		want string
	}{
		{`{"a":1}`, Assertion{Path: "b", Op: "exists"}, "Expected b to exist, but it is missing"},
		{`{"a":{"x":1}}`, Assertion{Path: "a", Op: "equals", Value: "1"}, "Expected a to equal 1, but it has a different value"},
		{`{"a":[1,2]}`, Assertion{Path: "a[1]", Op: "lt", Value: "2"}, "Expected a[1] to be less than 2, but it is 2"},
		{`{"a":"hello"}`, Assertion{Path: "a", Op: "contains", Value: "ell"}, ""},
		{`{"a":["x","y"]}`, Assertion{Path: "a", Op: "contains", Value: "y"}, ""},
		{`{"a":null}`, Assertion{Path: "a", Op: "not_exists"}, ""},
		{`not json`, Assertion{Path: "a", Op: "exists"}, "The response isn't valid JSON"},
	}
	for _, c := range cases {
		ok, msg := EvalAssertions(c.body, []Assertion{c.a})
		if (c.want == "") != ok || msg != c.want {
			t.Errorf("%s %+v: ok=%v msg=%q want %q", c.body, c.a, ok, msg, c.want)
		}
	}
}
