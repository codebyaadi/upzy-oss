// upzy-scan runs Upzy's active security scan: a curated, non-intrusive set of nuclei templates, against assets whose
// owners have proved they own them, at a rate the server sets. It needs only the API address and a scanner token.
//
//	UPZY_API_URL=https://api.example.com UPZY_SCANNER_TOKEN=upzy_agent_... upzy-scan
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"
)

type logWriter struct{}

func (logWriter) Write(p []byte) (int, error) {
	return fmt.Fprintf(os.Stderr, "%s %s", time.Now().UTC().Format("2006-01-02T15:04:05Z"), p)
}

func sleep(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

// Worker pulls scans and runs them one at a time: each is heavy, and the rate limit is per target.
type Worker struct {
	client  *Client
	scanner *Scanner
	logf    func(string, ...any)
	poll    time.Duration
}

// Run blocks until ctx is cancelled or the token is refused.
func (w *Worker) Run(ctx context.Context) error {
	for backoff := time.Second; ; {
		hello, err := w.client.Hello(ctx, w.scanner.SetID)
		if err == nil {
			w.logf("connected as %q (server protocol %d, template set %s)", hello.Scanner, hello.Protocol, w.scanner.SetID)
			if hello.PollSeconds > 0 {
				w.poll = time.Duration(hello.PollSeconds) * time.Second
			}
			break
		}
		if fatal(err) {
			return fmt.Errorf("the server refused this scanner's token: %w", err)
		}
		if ctx.Err() != nil {
			return nil
		}
		w.logf("cannot reach the server (%v); retrying in %s", err, backoff)
		sleep(ctx, backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
	for ctx.Err() == nil {
		jobs, err := w.client.Pull(ctx, 1)
		if err != nil {
			if fatal(err) {
				return fmt.Errorf("the server refused this scanner's token: %w", err)
			}
			if ctx.Err() == nil {
				w.logf("pull failed (%v); retrying", err)
				sleep(ctx, 15*time.Second)
			}
			continue
		}
		for _, j := range jobs {
			w.runJob(ctx, j)
		}
		if len(jobs) == 0 {
			sleep(ctx, w.poll)
		}
	}
	return nil
}

func (w *Worker) runJob(ctx context.Context, j Job) {
	w.logf("scanning %s (job %s, %d requests/s, %ds limit)", j.Host, j.JobID, j.RateLimitPerSecond, j.TimeoutSeconds)
	// The server gives a silent job to someone else after a few minutes; a scan can take longer than that.
	beat, stop := context.WithCancel(context.Background())
	go func() {
		for {
			sleep(beat, time.Minute)
			if beat.Err() != nil {
				return
			}
			if err := w.client.Heartbeat(beat, j.JobID); err != nil {
				w.logf("heartbeat for %s: %v", j.JobID, err)
			}
		}
	}()
	res := w.scanner.Run(ctx, j)
	stop()

	w.logf("scanned %s: %d finding(s), %d template(s), %d request(s) at most%s",
		j.Host, len(res.Findings), res.Provenance.TemplatesRun, res.Provenance.Requests, errNote(res.Error))
	for attempt := 1; attempt <= 4; attempt++ {
		rctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		err := w.client.Report(rctx, j.JobID, res)
		cancel()
		var ae *apiError
		switch {
		case err == nil:
			return
		case errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500:
			w.logf("result for %s not accepted: %v", j.JobID, err)
			return
		}
		time.Sleep(time.Duration(attempt) * 2 * time.Second)
	}
	w.logf("giving up reporting %s; the server will hand the scan to someone else", j.JobID)
}

func errNote(e string) string {
	if e == "" {
		return ""
	}
	return " (" + e + ")"
}

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("upzy-scan", version, "(nuclei "+engineVersion+")")
		return
	}
	l := log.New(logWriter{}, "", 0)
	logf := func(f string, a ...any) { l.Printf(f, a...) }

	apiURL, token := os.Getenv("UPZY_API_URL"), os.Getenv("UPZY_SCANNER_TOKEN")
	if apiURL == "" || token == "" {
		fmt.Fprintln(os.Stderr, "Set UPZY_API_URL (the API address) and UPZY_SCANNER_TOKEN (from `create-agent --scanner`).")
		os.Exit(2)
	}
	dir, setID, n, err := TemplateSet()
	if err != nil {
		logf("cannot unpack the template set: %v", err)
		os.Exit(1)
	}
	defer os.RemoveAll(dir)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logf("upzy-scan %s starting (nuclei %s, %d templates, set %s)", version, engineVersion, n, setID)
	w := &Worker{client: NewClient(apiURL, token), scanner: &Scanner{TemplateDir: dir, SetID: setID}, logf: logf, poll: 30 * time.Second}
	if err := w.Run(ctx); err != nil {
		logf("%v", err)
		os.Exit(1)
	}
	logf("stopped")
}
