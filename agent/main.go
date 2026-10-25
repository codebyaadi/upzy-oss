// upzy-agent runs Upzy checks from a machine of your own and reports what it measured. It needs only the API address
// and a token: no database access and no encryption key.
//
//	UPZY_API_URL=https://api.example.com UPZY_AGENT_TOKEN=upzy_agent_... upzy-agent
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

type logWriter struct{}

func (logWriter) Write(p []byte) (int, error) {
	return fmt.Fprintf(os.Stderr, "%s %s", time.Now().UTC().Format("2006-01-02T15:04:05Z"), p)
}

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println("upzy-agent", version)
		return
	}
	logf := newLogger()

	apiURL, token := os.Getenv("UPZY_API_URL"), os.Getenv("UPZY_AGENT_TOKEN")
	if apiURL == "" || token == "" {
		fmt.Fprintln(os.Stderr, "Set UPZY_API_URL (the API address) and UPZY_AGENT_TOKEN (from `create-agent`).")
		os.Exit(2)
	}
	concurrency := 50
	if v := os.Getenv("UPZY_AGENT_CONCURRENCY"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 500 {
			fmt.Fprintln(os.Stderr, "UPZY_AGENT_CONCURRENCY must be a whole number from 1 to 500")
			os.Exit(2)
		}
		concurrency = n
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logf("upzy-agent %s starting (up to %d checks at once)", version, concurrency)
	a := &Agent{
		client:      NewClient(apiURL, token),
		concurrency: concurrency,
		run:         RunProbe,
		logf:        logf,
		pollEvery:   5 * time.Second,
	}
	if err := a.Run(ctx, 20*time.Second); err != nil {
		logf("%v", err)
		os.Exit(1)
	}
	logf("stopped")
}
