package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The tables below are the ones in packages/probes/test/egress.test.ts and apps/api/test/app.test.ts, plus the
// alternative spellings of 127.0.0.1 that packages/validator/src/ssrf.ts screens. The agent must refuse all of them.

var blockedIPs = []string{
	"0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "127.255.255.254", "169.254.169.254", "172.16.0.1",
	"172.31.255.255", "192.168.1.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
	"::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1",
	"::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
	"64:ff9b::7f00:1", "2002:7f00:1::1",
	"not-an-ip", "",
}

var allowedIPs = []string{
	"1.1.1.1", "8.8.8.8", "93.184.216.34", "172.32.0.1", "100.63.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8",
}

func TestIsBlockedIP(t *testing.T) {
	for _, ip := range blockedIPs {
		if !IsBlockedIP(ip) {
			t.Errorf("%q should be blocked", ip)
		}
	}
	for _, ip := range allowedIPs {
		if IsBlockedIP(ip) {
			t.Errorf("%q should be allowed", ip)
		}
	}
}

// Hosts that must be refused before any connection: names, brackets, and the number spellings of loopback.
var blockedHosts = []string{
	"localhost", "foo.localhost", "LOCALHOST", "localhost.", "127.0.0.1", "[::1]", "169.254.169.254",
	"127.1", "2130706433", "0x7f.1", "0x7f000001", "0177.0.0.1", "017700000001", "10.1", "3232235777", "0xa9fea9fe",
	"4294967296", "1.2.3.4.5",
	"::ffff:7f00:1", "[::ffff:127.0.0.1]",
}

func TestResolvePublicRefusesBypasses(t *testing.T) {
	for _, h := range blockedHosts {
		_, err := ResolvePublic(context.Background(), h)
		var be *BlockedError
		if !errors.As(err, &be) {
			t.Errorf("%q: want a BlockedError, got %v", h, err)
		}
	}
}

func TestResolvePublicAllowsPublicLiterals(t *testing.T) {
	for _, h := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "[2606:4700:4700::1111]"} {
		if _, err := ResolvePublic(context.Background(), h); err != nil {
			t.Errorf("%q: %v", h, err)
		}
	}
}

func TestSafeFetchRefusesReachableLocalServer(t *testing.T) {
	testAllow = nil
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("secret")) }))
	defer srv.Close()
	_, err := SafeFetch(context.Background(), srv.URL+"/", FetchOptions{})
	var be *BlockedError
	if !errors.As(err, &be) {
		t.Fatalf("a local server must be refused even though it is reachable; got %v", err)
	}
}

func TestSafeFetchRefusesBadSchemes(t *testing.T) {
	for _, u := range []string{"file:///etc/passwd", "ftp://example.com/", "gopher://127.0.0.1/", "javascript:alert(1)"} {
		_, err := SafeFetch(context.Background(), u, FetchOptions{})
		var be *BlockedError
		if !errors.As(err, &be) {
			t.Errorf("%s: want a BlockedError, got %v", u, err)
		}
	}
}

// A first hop that is allowed (as if it were public) and redirects into link-local space must be stopped at hop two.
func TestSafeFetchChecksEveryRedirectHop(t *testing.T) {
	front := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
	}))
	defer front.Close()
	defer func() { testAllow = nil }()
	testAllow = func(ip string) bool { return ip == "127.0.0.1" }
	_, err := SafeFetch(context.Background(), front.URL+"/", FetchOptions{})
	var be *BlockedError
	if !errors.As(err, &be) {
		t.Fatalf("the redirect into link-local space must be refused; got %v", err)
	}
}

func TestSafeFetchNeverUsesProxyFromEnvironment(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	testAllow = func(ip string) bool { return ip == "127.0.0.1" }
	defer func() { testAllow = nil }()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte("hi")) }))
	defer srv.Close()
	res, err := SafeFetch(context.Background(), srv.URL+"/", FetchOptions{Timeout: 3 * time.Second})
	if err != nil || res.Body != "hi" {
		t.Fatalf("a proxy from the environment must be ignored: %v %v", res, err)
	}
}

func TestSafeFetchCapsTheBodyAndFollowsRedirects(t *testing.T) {
	testAllow = func(ip string) bool { return ip == "127.0.0.1" }
	defer func() { testAllow = nil }()
	mux := http.NewServeMux()
	mux.HandleFunc("/old", func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/big", http.StatusMovedPermanently) })
	mux.HandleFunc("/big", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(strings.Repeat("x", 5000))) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	res, err := SafeFetch(context.Background(), srv.URL+"/old", FetchOptions{MaxBody: 100})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Body) != 100 || !strings.HasSuffix(res.FinalURL, "/big") || res.Status != 200 {
		t.Fatalf("got %d bytes, final %s, status %d", len(res.Body), res.FinalURL, res.Status)
	}
}
