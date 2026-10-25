package main

import (
	"net/url"
	"regexp"
	"strings"

	"github.com/projectdiscovery/nuclei/v3/pkg/output"
)

// Finding is one security finding in the shape the server accepts (schemas/finding.schema.json).
type Finding struct {
	CheckKey    string         `json:"checkKey"`
	Severity    string         `json:"severity"`
	Title       string         `json:"title"`
	Description string         `json:"description"`
	Remediation string         `json:"remediation"`
	Subject     string         `json:"subject,omitempty"`
	Evidence    map[string]any `json:"evidence,omitempty"`
}

const (
	metaCheckKey = "upzy-check-key"
	metaSubject  = "upzy-subject"
	// genericFix is what a finding with no advice of its own is given.
	genericFix = "Remove the exposed resource or restrict access to it, then rotate any secret it may have held."
)

var nonKey = regexp.MustCompile(`[^a-z0-9]+`)

func clipTo(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// checkKeyFor turns a template id such as "git-config" into "nuclei.git_config": a check family and a slug, the shape
// every finding key has.
func checkKeyFor(templateID string) string {
	slug := strings.Trim(nonKey.ReplaceAllString(strings.ToLower(templateID), "_"), "_")
	if slug == "" {
		slug = "unknown"
	}
	return "nuclei." + clipTo(slug, 80)
}

func severityOf(s string) string {
	switch strings.ToLower(s) {
	case "critical", "high", "medium", "low":
		return strings.ToLower(s)
	}
	return "info" // info, unknown, anything else
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// pathOf is where on the site the template matched, without the query: it names the place, never what was read.
func pathOf(matched string) string {
	u, err := url.Parse(matched)
	if err != nil || u.Path == "" {
		return "/"
	}
	return u.Path
}

// MapEvent converts a nuclei result into a finding. Templates written by us carry the key and subject of the built-in
// check they replace (metadata upzy-check-key and upzy-subject), so a finding from either engine is the same finding
// and the two never show twice. Everything else becomes `nuclei.<template id>`.
//
// The evidence names the template and the path. It never includes the response, the extracted values or the matched
// text, because an exposed file may hold secrets and Upzy must not copy them.
func MapEvent(ev *output.ResultEvent) (Finding, bool) {
	if ev == nil || ev.TemplateID == "" {
		return Finding{}, false
	}
	f := Finding{
		Severity:    severityOf(ev.Info.SeverityHolder.Severity.String()),
		Title:       clipTo(strings.TrimSpace(ev.Info.Name), 290),
		Description: clipTo(strings.TrimSpace(ev.Info.Description), 4900),
		Remediation: clipTo(strings.TrimSpace(ev.Info.Remediation), 4900),
	}
	path := pathOf(ev.Matched)
	f.CheckKey = checkKeyFor(ev.TemplateID)
	f.Subject = clipTo(path, 290)
	f.Evidence = map[string]any{"template": ev.TemplateID, "path": path}

	if meta := ev.Info.Metadata; meta != nil {
		if k := str(meta[metaCheckKey]); k != "" {
			f.CheckKey = k
		}
		if s := str(meta[metaSubject]); s != "" {
			f.Subject = clipTo(s, 290)
		}
	}
	if f.Title == "" {
		f.Title = ev.TemplateID
	}
	if f.Description == "" {
		f.Description = "A check from the scanner's curated template set found " + f.Title + "."
	}
	if f.Remediation == "" {
		f.Remediation = genericFix
	}
	return f, true
}
