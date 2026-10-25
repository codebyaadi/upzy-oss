package main

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Port of packages/probes/src/assert.ts. Messages are identical so a monitor reads the same whichever side ran it.

// Assertion is one check on a JSON response body.
type Assertion struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	Value string `json:"value"`
}

var pathPart = regexp.MustCompile(`[^.\[\]]+`)

// ReadPath reads `data.items[0].status` out of parsed JSON. ok is false when any step is missing.
func ReadPath(root any, path string) (any, bool) {
	cur := root
	for _, part := range pathPart.FindAllString(path, -1) {
		switch c := cur.(type) {
		case map[string]any:
			v, ok := c[part]
			if !ok {
				return nil, false
			}
			cur = v
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(c) {
				return nil, false
			}
			cur = c[i]
		default:
			return nil, false
		}
	}
	return cur, true
}

func show(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func clip(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// RedactValues replaces every secret (and extracted variable) value in a message, so a failure never leaks one.
func RedactValues(text string, values []string) string {
	out := text
	for _, v := range values {
		if len(v) >= 4 {
			out = strings.ReplaceAll(out, v, "***")
		}
	}
	return out
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case string:
		f, err := strconv.ParseFloat(strings.TrimSpace(n), 64)
		return f, err == nil
	}
	return 0, false
}

// EvalAssertions checks assertions against a response body.
func EvalAssertions(body string, assertions []Assertion) (bool, string) {
	var root any
	if err := json.Unmarshal([]byte(body), &root); err != nil {
		return false, "The response isn't valid JSON"
	}
	labels := map[string]string{
		"equals": "equal", "not_equals": "differ from", "contains": "contain", "gt": "be greater than",
		"lt": "be less than", "exists": "exist", "not_exists": "be absent",
	}
	for _, a := range assertions {
		actual, found := ReadPath(root, a.Path)
		present := found && actual != nil
		var pass bool
		switch a.Op {
		case "exists":
			pass = present
		case "not_exists":
			pass = !present
		case "equals":
			pass = present && show(actual) == a.Value
		case "not_equals":
			pass = !present || show(actual) != a.Value
		case "contains":
			switch x := actual.(type) {
			case []any:
				for _, item := range x {
					if show(item) == a.Value {
						pass = true
						break
					}
				}
			case string:
				pass = strings.Contains(x, a.Value)
			}
		case "gt", "lt":
			got, ok1 := number(actual)
			want, ok2 := number(a.Value)
			if present && ok1 && ok2 {
				pass = (a.Op == "gt" && got > want) || (a.Op == "lt" && got < want)
			}
		}
		if pass {
			continue
		}
		shown := "it is missing"
		if present {
			switch actual.(type) {
			case map[string]any, []any:
				shown = "it has a different value"
			default:
				shown = "it is " + clip(show(actual), 40)
			}
		}
		tail := ""
		if a.Op != "exists" && a.Op != "not_exists" {
			tail = " " + clip(a.Value, 60)
		}
		return false, fmt.Sprintf("Expected %s to %s%s, but %s", a.Path, labels[a.Op], tail, shown)
	}
	return true, ""
}

var templateRe = regexp.MustCompile(`\{\{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}`)

// TemplateError is a {{name}} with no value.
type TemplateError struct{ msg string }

func (e *TemplateError) Error() string { return e.msg }

// Render fills {{variable}} and {{secret.NAME}}. An unknown name fails instead of sending a literal "{{x}}".
func Render(text string, vars, secrets map[string]string) (string, error) {
	var err error
	out := templateRe.ReplaceAllStringFunc(text, func(m string) string {
		name := templateRe.FindStringSubmatch(m)[1]
		var v string
		var ok bool
		if strings.HasPrefix(name, "secret.") {
			v, ok = secrets[name[7:]]
		} else {
			v, ok = vars[name]
		}
		if !ok && err == nil {
			err = &TemplateError{msg: "{{" + name + "}} has no value"}
		}
		return v
	})
	return out, err
}
