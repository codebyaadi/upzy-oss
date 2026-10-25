package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"time"

	nuclei "github.com/projectdiscovery/nuclei/v3/lib"
	"github.com/projectdiscovery/nuclei/v3/pkg/output"
)

// Job is one asset to scan (schemas/scanner-job.schema.json). The server decides what may be scanned and how hard;
// the scanner only obeys.
type Job struct {
	JobID              string `json:"jobId"`
	AssetID            string `json:"assetId"`
	Host               string `json:"host"`
	URL                string `json:"url"`
	RateLimitPerSecond int    `json:"rateLimitPerSecond"`
	TimeoutSeconds     int    `json:"timeoutSeconds"`
}

// Provenance says exactly what a scan did (schemas/scanner-result.schema.json), so the person who owns the site can
// see what was sent to it.
type Provenance struct {
	Engine             string   `json:"engine"`
	EngineVersion      string   `json:"engineVersion,omitempty"`
	TemplateSet        string   `json:"templateSet,omitempty"`
	TemplatesRun       int      `json:"templatesRun"`
	Requests           int      `json:"requests"`
	StartedAt          string   `json:"startedAt"`
	FinishedAt         string   `json:"finishedAt"`
	RateLimitPerSecond int      `json:"rateLimitPerSecond"`
	Templates          []string `json:"templates"`
}

// Result is what is reported for a job.
type Result struct {
	Findings   []Finding  `json:"findings"`
	Provenance Provenance `json:"provenance"`
	Error      string     `json:"error,omitempty"`
}

// Scanner runs the curated template set.
type Scanner struct {
	TemplateDir string
	SetID       string
	// allowLocal disables the check that the target is public. Only tests set it, to scan a server on this machine.
	allowLocal bool
}

// engineVersion is the nuclei release this binary embeds (kept in step with go.mod by a test).
const engineVersion = "v3.11.1"

// A template that could change anything on the site, or that needs a server on the internet to confirm, is never run,
// whatever the set contains. The set is also reviewed by hand (templates/UPSTREAM.md); this is the second lock.
var excludedTags = []string{
	"intrusive", "dos", "fuzz", "fuzzing", "bruteforce", "brute-force", "dast", "rce", "sqli", "xss", "ssrf",
	"oast", "interactsh", "headless", "code", "default-login", "takeover",
}

// Run scans one asset. It never returns an error for a scan that found nothing or was cut short: those are results.
func (s *Scanner) Run(ctx context.Context, job Job) Result {
	started := time.Now().UTC()
	prov := Provenance{
		Engine: "nuclei", EngineVersion: engineVersion, TemplateSet: s.SetID,
		StartedAt: started.Format(time.RFC3339), RateLimitPerSecond: job.RateLimitPerSecond, Templates: []string{},
	}
	finish := func(findings []Finding, errMsg string) Result {
		prov.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		if findings == nil {
			findings = []Finding{}
		}
		return Result{Findings: findings, Provenance: prov, Error: errMsg}
	}

	// First lock: the target must be a public address. Nothing is sent before this passes.
	if !s.allowLocal {
		if _, err := ResolvePublic(ctx, job.Host); err != nil {
			var be *BlockedError
			if errors.As(err, &be) {
				return finish(nil, "Refused: "+be.Error())
			}
			return finish(nil, "Could not resolve the target: "+clipTo(err.Error(), 200))
		}
	}
	if job.RateLimitPerSecond < 1 || job.TimeoutSeconds < 1 {
		return finish(nil, "The job had no rate limit or time limit")
	}

	ctx, cancel := context.WithTimeout(ctx, time.Duration(job.TimeoutSeconds)*time.Second)
	defer cancel()

	eng, err := nuclei.NewNucleiEngineCtx(ctx,
		// No version check, no template download, no ignore-file fetch: without this nuclei installs its public
		// templates from GitHub on first use, and the set that runs would no longer be the one in the binary.
		nuclei.DisableUpdateCheck(),
		nuclei.WithTemplatesOrWorkflows(nuclei.TemplateSources{Templates: []string{s.TemplateDir}}),
		nuclei.WithTemplateFilters(nuclei.TemplateFilters{
			ProtocolTypes: "http",
			ExcludeTags:   excludedTags,
		}),
		// At most this many requests a second to the site, across every template together.
		nuclei.WithGlobalRateLimitCtx(ctx, job.RateLimitPerSecond, time.Second),
		nuclei.WithConcurrency(nuclei.Concurrency{
			TemplateConcurrency: 4, HostConcurrency: 1, HeadlessHostConcurrency: 1, HeadlessTemplateConcurrency: 1,
			JavascriptTemplateConcurrency: 1, TemplatePayloadConcurrency: 4, ProbeConcurrency: 4,
		}),
		nuclei.WithNetworkConfig(nuclei.NetworkConfig{Retries: 1, Timeout: 10, MaxHostError: 30}),
		// Second lock: nuclei refuses to connect to private or local addresses while it runs, so a redirect or a
		// DNS answer that changes after the check above cannot take the scan inside the network.
		nuclei.WithSandboxOptions(false, !s.allowLocal),
		nuclei.WithResponseReadSize(20_000),
		nuclei.WithTemplateUpdateCallback(true, nil),
		nuclei.WithVerbosity(nuclei.VerbosityOptions{Silent: true}),
	)
	if err != nil {
		return finish(nil, "Could not start the scan engine: "+clipTo(err.Error(), 300))
	}
	defer eng.Close()

	if err := eng.LoadAllTemplates(); err != nil {
		return finish(nil, "Could not load the templates: "+clipTo(err.Error(), 300))
	}
	for _, t := range eng.GetTemplates() {
		prov.Templates = append(prov.Templates, t.ID)
		prov.Requests += t.TotalRequests
	}
	sort.Strings(prov.Templates)
	prov.TemplatesRun = len(prov.Templates)

	eng.LoadTargets([]string{job.URL}, false)

	var mu sync.Mutex
	seen := map[string]bool{}
	var findings []Finding
	err = eng.ExecuteWithCallback(func(ev *output.ResultEvent) {
		f, ok := MapEvent(ev)
		if !ok {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if key := f.CheckKey + "\n" + f.Subject; !seen[key] {
			seen[key] = true
			findings = append(findings, f)
		}
	})
	switch {
	case errors.Is(ctx.Err(), context.DeadlineExceeded):
		return finish(findings, fmt.Sprintf("The scan reached its %d second limit", job.TimeoutSeconds))
	case err != nil:
		return finish(findings, "The scan stopped early: "+clipTo(err.Error(), 300))
	}
	return finish(findings, "")
}
