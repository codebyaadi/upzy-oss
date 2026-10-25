package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"runtime"
	"strings"
	"sync"
	"time"
)

// version is set at build time: go build -ldflags "-X main.version=1.2.3".
var version = "dev"

const protocol = 1

// apiError is a non-2xx answer from the server.
type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("server answered %d: %s", e.Status, e.Body) }

// Client talks to the Upzy API as one agent (docs: schemas/ and docs/guides/MULTI-REGION.md).
type Client struct {
	base  string
	token string
	http  *http.Client
}

func NewClient(base, token string) *Client {
	return &Client{
		base:  strings.TrimRight(base, "/"),
		token: token,
		// The agent's own calls to the API use the ordinary client and system proxy settings; only the checks it
		// runs for customers go through the guarded dialer.
		http: &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) post(ctx context.Context, path string, in, out any) error {
	b, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", c.base+path, bytes.NewReader(b))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "upzy-agent/"+version)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode/100 != 2 {
		return &apiError{Status: res.StatusCode, Body: clip(string(body), 200)}
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

type helloReply struct {
	Agent       string `json:"agent"`
	Region      string `json:"region"`
	Protocol    int    `json:"protocol"`
	PollSeconds int    `json:"pollSeconds"`
}

func (c *Client) Hello(ctx context.Context) (helloReply, error) {
	var r helloReply
	err := c.post(ctx, "/agent/hello", map[string]any{
		"version": version, "os": runtime.GOOS, "arch": runtime.GOARCH, "protocol": protocol,
	}, &r)
	return r, err
}

func (c *Client) Pull(ctx context.Context, max int) ([]Job, error) {
	var r struct {
		Jobs []Job `json:"jobs"`
	}
	err := c.post(ctx, "/agent/jobs/pull", map[string]any{"max": max}, &r)
	return r.Jobs, err
}

func (c *Client) Report(ctx context.Context, jobID string, r Result) error {
	return c.post(ctx, "/agent/jobs/"+jobID+"/result", r, nil)
}

// fatal reports whether retrying cannot help: the token is wrong or revoked.
func fatal(err error) bool {
	var ae *apiError
	return errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403)
}

// Agent pulls checks, runs them and reports what it measured.
type Agent struct {
	client      *Client
	concurrency int
	run         func(context.Context, Job) Result
	logf        func(string, ...any)
	// pollEvery is how long to wait after a pull that found nothing; the server suggests a value in hello.
	pollEvery time.Duration
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Run blocks until ctx is cancelled (then waits for checks in flight, up to grace) or the token is refused.
func (a *Agent) Run(ctx context.Context, grace time.Duration) error {
	// Say hello until the server answers. A refused token is not retried.
	for backoff := time.Second; ; {
		hello, err := a.client.Hello(ctx)
		if err == nil {
			a.logf("connected as %q for region %s (server protocol %d)", hello.Agent, hello.Region, hello.Protocol)
			if hello.Protocol > protocol {
				a.logf("the server speaks a newer protocol (%d); update this agent", hello.Protocol)
			}
			if hello.PollSeconds > 0 {
				a.pollEvery = time.Duration(hello.PollSeconds) * time.Second
			}
			break
		}
		if fatal(err) {
			return fmt.Errorf("the server refused this agent's token: %w", err)
		}
		if ctx.Err() != nil {
			return nil
		}
		a.logf("cannot reach the server (%v); retrying in %s", err, backoff)
		sleep(ctx, backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}

	var wg sync.WaitGroup
	slots := make(chan struct{}, a.concurrency)
	failures := 0
	for ctx.Err() == nil {
		free := a.concurrency - len(slots)
		if free <= 0 {
			sleep(ctx, 100*time.Millisecond)
			continue
		}
		if free > 50 {
			free = 50
		}
		jobs, err := a.client.Pull(ctx, free)
		if err != nil {
			if fatal(err) {
				return fmt.Errorf("the server refused this agent's token: %w", err)
			}
			if ctx.Err() != nil {
				break
			}
			failures++
			wait := time.Duration(min(failures, 6)) * 5 * time.Second
			a.logf("pull failed (%v); retrying in %s", err, wait)
			sleep(ctx, wait)
			continue
		}
		failures = 0
		for _, j := range jobs {
			slots <- struct{}{}
			wg.Add(1)
			go func() {
				defer func() { <-slots; wg.Done() }()
				a.runOne(j)
			}()
		}
		if len(jobs) == 0 {
			sleep(ctx, a.pollEvery)
		}
	}

	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(grace):
		a.logf("stopping with checks still running")
	}
	return nil
}

// runOne runs a check and reports it. It uses its own context: a shutdown lets checks in flight finish and report.
func (a *Agent) runOne(j Job) {
	res := a.run(context.Background(), j)
	for attempt := 1; attempt <= 4; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := a.client.Report(ctx, j.JobID, res)
		cancel()
		var ae *apiError
		switch {
		case err == nil:
			return
		case errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500:
			// 404: another taker already answered, or the check expired. Nothing to retry.
			a.logf("result for %s not accepted: %v", j.JobID, err)
			return
		}
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	a.logf("giving up reporting %s; the server will hand the check to someone else", j.JobID)
}

func newLogger() func(string, ...any) {
	l := log.New(logWriter{}, "", 0)
	return func(f string, a ...any) { l.Printf(f, a...) }
}
