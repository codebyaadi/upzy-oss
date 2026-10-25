package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Port of packages/probes/src/probes.ts. The agent only measures; the server decides what a result means.

// Job is one check handed out by the server (schemas/agent-job.schema.json).
type Job struct {
	JobID     string          `json:"jobId"`
	MonitorID string          `json:"monitorId"`
	Type      string          `json:"type"`
	Target    string          `json:"target"`
	Config    json.RawMessage `json:"config"`
	// SealedSecrets are the monitor's secrets, encrypted to this agent. Secrets is what they open to.
	SealedSecrets *Sealed           `json:"sealedSecrets,omitempty"`
	Secrets       map[string]string `json:"-"`
}

// Result is what the agent reports (schemas/agent-result.schema.json). ResponseMs is null for a check that never got
// an answer, hence the pointer without omitempty.
type Result struct {
	Status      string `json:"status"`
	ResponseMs  *int   `json:"responseMs"`
	StatusCode  *int   `json:"statusCode,omitempty"`
	TTFBMs      *int   `json:"ttfbMs,omitempty"`
	TLSDaysLeft *int   `json:"tlsDaysLeft,omitempty"`
	Error       string `json:"error,omitempty"`
	ErrorKind   string `json:"errorKind,omitempty"`
}

type step struct {
	Name           string            `json:"name"`
	Method         string            `json:"method"`
	URL            string            `json:"url"`
	Headers        map[string]string `json:"headers"`
	Body           *string           `json:"body"`
	ExpectedStatus []int             `json:"expectedStatus"`
	Assertions     []Assertion       `json:"assertions"`
	Extract        map[string]string `json:"extract"`
}

type monitorConfig struct {
	Method         string            `json:"method"`
	ExpectedStatus []int             `json:"expectedStatus"`
	Keyword        string            `json:"keyword"`
	TimeoutMs      int               `json:"timeoutMs"`
	Headers        map[string]string `json:"headers"`
	Body           *string           `json:"body"`
	Assertions     []Assertion       `json:"assertions"`
	Steps          []step            `json:"steps"`
}

const (
	defaultTimeout = 10 * time.Second
	flowBudget     = 30 * time.Second
	maxCheckTime   = 60 * time.Second
)

func ptr(n int) *int { return &n }

func since(t time.Time) *int { return ptr(int(time.Since(t).Milliseconds())) }

func (c monitorConfig) timeout() time.Duration {
	if c.TimeoutMs > 0 {
		return time.Duration(c.TimeoutMs) * time.Millisecond
	}
	return defaultTimeout
}

// classify maps an error to the same message and kind the TypeScript prober gives it.
func classify(err error) (string, string) {
	var be *BlockedError
	if errors.As(err, &be) {
		return be.Error(), "blocked"
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) ||
		regexp.MustCompile(`(?i)timed? ?out`).MatchString(err.Error()) {
		return "Request timed out", "timeout"
	}
	var de *net.DNSError
	if errors.As(err, &de) {
		return "DNS lookup failed (ENOTFOUND)", "dns"
	}
	msg := err.Error()
	if strings.Contains(strings.ToLower(msg), "connection refused") ||
		strings.Contains(strings.ToLower(msg), "actively refused") {
		return "Connection refused", "refused"
	}
	if regexp.MustCompile(`(?i)certificate|tls|ssl|x509`).MatchString(msg) {
		return clip(msg, 480), "tls"
	}
	return clip(msg, 480), "other"
}

func down(started time.Time, err error, secrets map[string]string) Result {
	msg, kind := classify(err)
	var te *TemplateError
	if errors.As(err, &te) {
		msg, kind = te.Error(), "other"
	}
	return Result{Status: "down", ResponseMs: since(started), Error: RedactValues(msg, valuesOf(secrets)), ErrorKind: kind}
}

func valuesOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func statusOK(status int, expected []int) bool {
	if len(expected) > 0 {
		for _, e := range expected {
			if e == status {
				return true
			}
		}
		return false
	}
	return status >= 200 && status < 400
}

func looksJSON(b string) bool {
	t := strings.TrimLeft(b, " \t\r\n")
	return strings.HasPrefix(t, "{") || strings.HasPrefix(t, "[")
}

// requestOf renders a step's headers and body, adding a content type when there is a body and none was given.
func requestOf(method string, headers map[string]string, body *string, vars, secrets map[string]string) (map[string]string, *string, error) {
	out := map[string]string{}
	for k, v := range headers {
		r, err := Render(v, vars, secrets)
		if err != nil {
			return nil, nil, err
		}
		out[k] = r
	}
	var b *string
	if body != nil {
		r, err := Render(*body, vars, secrets)
		if err != nil {
			return nil, nil, err
		}
		b = &r
		has := false
		for k := range out {
			if strings.EqualFold(k, "content-type") {
				has = true
			}
		}
		if !has {
			if looksJSON(r) {
				out["content-type"] = "application/json"
			} else {
				out["content-type"] = "text/plain"
			}
		}
	}
	return out, b, nil
}

func probeHTTP(ctx context.Context, j Job, cfg monitorConfig) Result {
	started := time.Now()
	method := cfg.Method
	if method == "" {
		method = "GET"
	}
	url, err := Render(j.Target, nil, j.Secrets)
	if err != nil {
		return down(started, err, j.Secrets)
	}
	headers, body, err := requestOf(method, cfg.Headers, cfg.Body, nil, j.Secrets)
	if err != nil {
		return down(started, err, j.Secrets)
	}
	if cfg.Keyword != "" && method == "HEAD" {
		method = "GET"
	}
	res, err := SafeFetch(ctx, url, FetchOptions{Method: method, Timeout: cfg.timeout(), Headers: headers, Body: body})
	if err != nil {
		return down(started, err, j.Secrets)
	}
	base := Result{ResponseMs: ptr(res.TotalMs), StatusCode: ptr(res.Status), TTFBMs: ptr(res.TTFBMs)}
	fail := func(msg, kind string) Result {
		base.Status, base.Error, base.ErrorKind = "down", msg, kind
		return base
	}
	if !statusOK(res.Status, cfg.ExpectedStatus) {
		return fail(fmt.Sprintf("Unexpected status %d", res.Status), "http")
	}
	if cfg.Keyword != "" && !strings.Contains(res.Body, cfg.Keyword) {
		return fail("Expected keyword not found", "http")
	}
	if len(cfg.Assertions) > 0 {
		if ok, msg := EvalAssertions(res.Body, cfg.Assertions); !ok {
			return fail(msg, "assertion")
		}
	}
	base.Status = "up"
	return base
}

// probeFlow runs a sequence of requests, each able to use values read from an earlier response. The first step that
// fails ends the run and names itself. Every message is scrubbed of secrets and extracted values.
func probeFlow(ctx context.Context, j Job, cfg monitorConfig) Result {
	started := time.Now()
	deadline := started.Add(flowBudget)
	vars := map[string]string{}
	var last *FetchResult
	scrub := func(s string) string {
		return RedactValues(s, append(valuesOf(j.Secrets), valuesOf(vars)...))
	}
	fail := func(n int, msg, kind string) Result {
		name := ""
		if n-1 < len(cfg.Steps) {
			name = cfg.Steps[n-1].Name
		}
		r := Result{Status: "down", ResponseMs: since(started), ErrorKind: kind,
			Error: clip(scrub(fmt.Sprintf("Step %d (%s): %s", n, name, msg)), 480)}
		if last != nil {
			r.StatusCode = ptr(last.Status)
		}
		return r
	}
	for i, s := range cfg.Steps {
		n := i + 1
		left := time.Until(deadline)
		if left <= 0 {
			return fail(n, "the flow ran out of time", "timeout")
		}
		stepURL, err := Render(s.URL, vars, j.Secrets)
		var headers map[string]string
		var body *string
		if err == nil {
			headers, body, err = requestOf(s.Method, s.Headers, s.Body, vars, j.Secrets)
		}
		if err != nil {
			return fail(n, err.Error(), "other")
		}
		timeout := cfg.timeout()
		if left < timeout {
			timeout = left
		}
		res, err := SafeFetch(ctx, stepURL, FetchOptions{Method: s.Method, Timeout: timeout, Headers: headers, Body: body})
		if err != nil {
			msg, kind := classify(err)
			return fail(n, msg, kind)
		}
		last = res
		if !statusOK(res.Status, s.ExpectedStatus) {
			return fail(n, fmt.Sprintf("unexpected status %d", res.Status), "http")
		}
		if len(s.Assertions) > 0 {
			if ok, msg := EvalAssertions(res.Body, s.Assertions); !ok {
				return fail(n, msg, "assertion")
			}
		}
		if len(s.Extract) > 0 {
			var root any
			if json.Unmarshal([]byte(res.Body), &root) != nil {
				return fail(n, "the response isn't JSON, so values can't be read from it", "assertion")
			}
			names := make([]string, 0, len(s.Extract))
			for name := range s.Extract {
				names = append(names, name)
			}
			sort.Strings(names)
			for _, name := range names {
				path := s.Extract[name]
				v, ok := ReadPath(root, path)
				switch v.(type) {
				case map[string]any, []any:
					ok = false
				}
				if !ok || v == nil {
					return fail(n, fmt.Sprintf("couldn't read %s from the response (needed for {{%s}})", path, name), "assertion")
				}
				vars[name] = show(v)
			}
		}
	}
	r := Result{Status: "up", ResponseMs: since(started)}
	if last != nil {
		r.StatusCode, r.TTFBMs = ptr(last.Status), ptr(last.TTFBMs)
	}
	return r
}

func probeTCP(ctx context.Context, j Job, cfg monitorConfig) Result {
	started := time.Now()
	idx := strings.LastIndex(j.Target, ":")
	if idx < 0 {
		return Result{Status: "down", ResponseMs: since(started), Error: "Target must be host:port", ErrorKind: "other"}
	}
	host, port := j.Target[:idx], j.Target[idx+1:]
	if p, err := strconv.Atoi(port); err != nil || p < 1 || p > 65535 {
		return Result{Status: "down", ResponseMs: since(started), Error: "Invalid port", ErrorKind: "other"}
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.timeout())
	defer cancel()
	conn, err := dialPublic(ctx, guardedDialer(cfg.timeout()), host, port)
	if err != nil {
		return down(started, err, nil)
	}
	_ = conn.Close()
	return Result{Status: "up", ResponseMs: since(started)}
}

func probeDNS(ctx context.Context, j Job, cfg monitorConfig) Result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, cfg.timeout())
	defer cancel()
	found := false
	for _, network := range []string{"ip4", "ip6"} {
		if ips, err := net.DefaultResolver.LookupNetIP(ctx, network, j.Target); err == nil && len(ips) > 0 {
			found = true
		}
	}
	if !found {
		return Result{Status: "down", ResponseMs: since(started), Error: "No A/AAAA records", ErrorKind: "dns"}
	}
	return Result{Status: "up", ResponseMs: since(started)}
}

func probeSSL(ctx context.Context, j Job, cfg monitorConfig) Result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, cfg.timeout())
	defer cancel()
	ip, err := ResolvePublic(ctx, j.Target)
	if err != nil {
		return down(started, err, nil)
	}
	raw, err := guardedDialer(cfg.timeout()).DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), "443"))
	if err != nil {
		return down(started, err, nil)
	}
	conn := tls.Client(raw, &tls.Config{ServerName: j.Target, MinVersion: tls.VersionTLS12})
	defer conn.Close()
	if err := conn.HandshakeContext(ctx); err != nil {
		return down(started, err, nil)
	}
	responseMs := since(started)
	certs := conn.ConnectionState().PeerCertificates
	if len(certs) == 0 {
		return Result{Status: "down", ResponseMs: responseMs, Error: "Could not read certificate expiry", ErrorKind: "tls"}
	}
	days := int(time.Until(certs[0].NotAfter).Hours() / 24)
	if certs[0].NotAfter.Before(time.Now()) {
		days = -int(time.Since(certs[0].NotAfter).Hours()/24) - 1
		return Result{Status: "down", ResponseMs: responseMs, TLSDaysLeft: ptr(days), Error: "Certificate has expired", ErrorKind: "tls"}
	}
	return Result{Status: "up", ResponseMs: responseMs, TLSDaysLeft: ptr(days)}
}

// RunProbe runs one check. It never fails: problems become a "down" result with a classified error.
func RunProbe(ctx context.Context, j Job) Result {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, maxCheckTime)
	defer cancel()
	var cfg monitorConfig
	if len(j.Config) > 0 {
		if err := json.Unmarshal(j.Config, &cfg); err != nil {
			return Result{Status: "down", ResponseMs: since(started), Error: "The monitor's settings could not be read", ErrorKind: "other"}
		}
	}
	switch j.Type {
	case "http":
		return probeHTTP(ctx, j, cfg)
	case "flow":
		return probeFlow(ctx, j, cfg)
	case "tcp":
		return probeTCP(ctx, j, cfg)
	case "dns":
		return probeDNS(ctx, j, cfg)
	case "ssl":
		return probeSSL(ctx, j, cfg)
	}
	return Result{Status: "down", ResponseMs: since(started), Error: j.Type + " monitors are not supported by this agent", ErrorKind: "other"}
}
