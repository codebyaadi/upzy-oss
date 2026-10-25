package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"
)

// version is set at build time: go build -ldflags "-X main.version=1.2.3".
var version = "dev"

const protocol = 1

type apiError struct {
	Status int
	Body   string
}

func (e *apiError) Error() string { return fmt.Sprintf("server answered %d: %s", e.Status, e.Body) }

// fatal reports whether retrying cannot help: the token is wrong or revoked.
func fatal(err error) bool {
	var ae *apiError
	return errors.As(err, &ae) && (ae.Status == 401 || ae.Status == 403)
}

// Client talks to the scanner API (apps/api/src/modules/scanner.ts).
type Client struct {
	base, token string
	http        *http.Client
}

func NewClient(base, token string) *Client {
	return &Client{base: strings.TrimRight(base, "/"), token: token, http: &http.Client{Timeout: 30 * time.Second}}
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
	req.Header.Set("User-Agent", "upzy-scan/"+version)
	res, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode/100 != 2 {
		return &apiError{Status: res.StatusCode, Body: clipTo(string(body), 200)}
	}
	if out != nil {
		return json.Unmarshal(body, out)
	}
	return nil
}

type helloReply struct {
	Scanner     string `json:"scanner"`
	Protocol    int    `json:"protocol"`
	PollSeconds int    `json:"pollSeconds"`
}

func (c *Client) Hello(ctx context.Context, templateSet string) (helloReply, error) {
	var r helloReply
	err := c.post(ctx, "/scanner/hello", map[string]any{
		"version": version, "engine": "nuclei", "engineVersion": engineVersion, "templateSet": templateSet,
		"os": runtime.GOOS, "arch": runtime.GOARCH, "protocol": protocol,
	}, &r)
	return r, err
}

func (c *Client) Pull(ctx context.Context, max int) ([]Job, error) {
	var r struct {
		Jobs []Job `json:"jobs"`
	}
	err := c.post(ctx, "/scanner/jobs/pull", map[string]any{"max": max}, &r)
	return r.Jobs, err
}

func (c *Client) Heartbeat(ctx context.Context, jobID string) error {
	return c.post(ctx, "/scanner/jobs/"+jobID+"/heartbeat", map[string]any{}, nil)
}

func (c *Client) Report(ctx context.Context, jobID string, r Result) error {
	return c.post(ctx, "/scanner/jobs/"+jobID+"/result", r, nil)
}
