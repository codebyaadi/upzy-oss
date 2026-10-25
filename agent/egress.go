package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// This file is the agent's counterpart of packages/probes/src/egress.ts: the same rules about which addresses a check
// may touch. Two layers, so that no single mistake opens a way in:
//
//  1. Before connecting, the target name is resolved and every address must be public (one private record rejects the
//     whole name). The connection then goes to the address that was checked, never to a second lookup.
//  2. The socket itself refuses a blocked address at connect time (net.Dialer.Control), so redirects, odd address
//     spellings and DNS rebinding cannot get around layer 1.

// BlockedError means the target is not publicly routable. It is reported as a "blocked" check, not a crash.
type BlockedError struct{ msg string }

func (e *BlockedError) Error() string { return e.msg }

func blocked(format string, a ...any) error { return &BlockedError{msg: fmt.Sprintf(format, a...)} }

var v4Blocks = mustPrefixes(
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10", // CGNAT
	"127.0.0.0/8",
	"169.254.0.0/16", // link-local, cloud metadata
	"172.16.0.0/12",
	"192.0.0.0/24",
	"192.168.0.0/16",
	"198.18.0.0/15",
	"224.0.0.0/3", // multicast, reserved, broadcast
)

func mustPrefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(cidrs))
	for i, c := range cidrs {
		out[i] = netip.MustParsePrefix(c)
	}
	return out
}

func blockedV4(a netip.Addr) bool {
	for _, p := range v4Blocks {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// IsBlockedIP reports whether an address is not publicly routable. Anything that does not parse is blocked.
func IsBlockedIP(s string) bool {
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	if i := strings.IndexByte(s, '%'); i >= 0 { // zone
		s = s[:i]
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return true
	}
	return blockedAddr(a)
}

func blockedAddr(a netip.Addr) bool {
	if a.Is4() {
		return blockedV4(a)
	}
	a = a.Unmap() // ::ffff:a.b.c.d is the v4 address
	if a.Is4() {
		return blockedV4(a)
	}
	b := a.As16()
	zero := func(from, to int) bool {
		for _, x := range b[from:to] {
			if x != 0 {
				return false
			}
		}
		return true
	}
	switch {
	case a.IsUnspecified(), a.IsLoopback():
		return true
	case b[0]&0xfe == 0xfc: // fc00::/7 unique local
		return true
	case b[0] == 0xfe && b[1]&0xc0 == 0x80: // fe80::/10 link-local
		return true
	case b[0] == 0xff: // multicast
		return true
	case zero(0, 12): // ::/96 IPv4-compatible
		return blockedV4(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	case b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xff && b[3] == 0x9b && zero(4, 12): // 64:ff9b::/96 NAT64
		return blockedV4(netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}))
	case b[0] == 0x20 && b[1] == 0x02: // 2002::/16 6to4
		return blockedV4(netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}))
	}
	return false
}

var legacyNumeric = regexp.MustCompile(`^[0-9a-fx.]+$`)
var hasDigit = regexp.MustCompile(`\d`)

// legacyIPv4 decodes the spellings that many resolvers accept for an IPv4 address ("2130706433", "0x7f.1", "127.1",
// "0177.0.0.1"). ok is false when the host is not written that way. A malformed one comes back as an unspecified
// address, which is blocked.
func legacyIPv4(host string) (addr netip.Addr, ok bool) {
	if !legacyNumeric.MatchString(host) || !hasDigit.MatchString(host) {
		return netip.Addr{}, false
	}
	if a, err := netip.ParseAddr(host); err == nil && a.Is4() {
		return a, true // the ordinary dotted form
	}
	var n float64
	parts := strings.Split(host, ".")
	num := make([]float64, len(parts))
	for i, p := range parts {
		var v uint64
		var err error
		switch {
		case strings.HasPrefix(p, "0x"):
			v, err = strconv.ParseUint(p[2:], 16, 64)
		case len(p) > 1 && p[0] == '0':
			v, err = strconv.ParseUint(p[1:], 8, 64)
		default:
			v, err = strconv.ParseUint(p, 10, 64)
		}
		if err != nil {
			return netip.IPv4Unspecified(), true
		}
		num[i] = float64(v)
	}
	switch len(num) {
	case 1:
		n = num[0]
	case 2:
		n = num[0]*math.Pow(2, 24) + num[1]
	case 3:
		n = num[0]*math.Pow(2, 24) + num[1]*math.Pow(2, 16) + num[2]
	case 4:
		n = num[0]*math.Pow(2, 24) + num[1]*math.Pow(2, 16) + num[2]*256 + num[3]
	default:
		return netip.IPv4Unspecified(), true
	}
	if n >= math.Pow(2, 32) {
		return netip.IPv4Unspecified(), true
	}
	u := uint32(n)
	return netip.AddrFrom4([4]byte{byte(u >> 24), byte(u >> 16), byte(u >> 8), byte(u)}), true
}

// testAllow lets tests reach servers on the loopback address. Production code never sets it.
var testAllow func(ip string) bool

func addrBlocked(ip string) bool {
	if testAllow != nil && testAllow(ip) {
		return false
	}
	return IsBlockedIP(ip)
}

// ResolvePublic returns an address that is safe to connect to for host, or a *BlockedError.
func ResolvePublic(ctx context.Context, host string) (netip.Addr, error) {
	host = strings.TrimSuffix(strings.TrimPrefix(host, "["), "]")
	if a, err := netip.ParseAddr(strings.SplitN(host, "%", 2)[0]); err == nil {
		if addrBlocked(a.String()) {
			return netip.Addr{}, blocked("Target address %s is not publicly routable", host)
		}
		return a, nil
	}
	if a, ok := legacyIPv4(strings.ToLower(host)); ok {
		if addrBlocked(a.String()) {
			return netip.Addr{}, blocked("Target address %s is not publicly routable", host)
		}
		return a, nil
	}
	lower := strings.ToLower(strings.TrimSuffix(host, "."))
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		return netip.Addr{}, blocked("Target resolves to a private address")
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return netip.Addr{}, err
	}
	if len(ips) == 0 {
		return netip.Addr{}, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	for _, ip := range ips {
		if addrBlocked(ip.String()) {
			return netip.Addr{}, blocked("Target resolves to a private address")
		}
	}
	return ips[0], nil
}

// controlBlocked runs on the socket just before connect, with the address actually about to be dialled.
func controlBlocked(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return blocked("Unreadable address %q", address)
	}
	if addrBlocked(host) {
		return blocked("Target address %s is not publicly routable", host)
	}
	return nil
}

func guardedDialer(timeout time.Duration) *net.Dialer {
	return &net.Dialer{Timeout: timeout, Control: controlBlocked}
}

// dialPublic resolves, checks and connects to host:port.
func dialPublic(ctx context.Context, d *net.Dialer, host, port string) (net.Conn, error) {
	ip, err := ResolvePublic(ctx, host)
	if err != nil {
		return nil, err
	}
	return d.DialContext(ctx, "tcp", net.JoinHostPort(ip.String(), port))
}

// FetchOptions mirrors SafeFetchOptions in egress.ts.
type FetchOptions struct {
	Method       string
	Body         *string
	Timeout      time.Duration
	MaxRedirects int
	MaxBody      int
	Headers      map[string]string
}

// FetchResult mirrors SafeFetchResult.
type FetchResult struct {
	Status    int
	Headers   map[string]string
	FinalURL  string
	Body      string
	TTFBMs    int
	TotalMs   int
	SetCookie []string
}

func botUserAgent() string {
	if origin := strings.TrimRight(os.Getenv("WEB_ORIGIN"), "/"); strings.HasPrefix(origin, "https://") {
		return "UpzyBot/1.0 (+" + origin + "/bot)"
	}
	return "UpzyBot/1.0"
}

// SafeFetch is an SSRF-safe HTTP(S) request: it follows at most MaxRedirects redirects, checks every hop, never uses a
// proxy from the environment, and caps the body.
func SafeFetch(ctx context.Context, rawURL string, o FetchOptions) (*FetchResult, error) {
	if o.Method == "" {
		o.Method = "GET"
	}
	if o.Timeout <= 0 {
		o.Timeout = 10 * time.Second
	}
	if o.MaxRedirects == 0 {
		o.MaxRedirects = 5
	}
	if o.MaxBody == 0 {
		o.MaxBody = 1_000_000
	}
	ctx, cancel := context.WithTimeout(ctx, o.Timeout)
	defer cancel()
	started := time.Now()

	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, blocked("Unreadable address")
	}
	d := guardedDialer(o.Timeout)
	tr := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			return dialPublic(ctx, d, host, port)
		},
		TLSHandshakeTimeout: o.Timeout,
		DisableKeepAlives:   true,
	}
	defer tr.CloseIdleConnections()
	client := &http.Client{
		Transport:     tr,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	for hop := 0; hop <= o.MaxRedirects; hop++ {
		if u.Scheme != "http" && u.Scheme != "https" {
			return nil, blocked("Unsupported scheme %s:", u.Scheme)
		}
		var body io.Reader
		if o.Body != nil && (o.Method == "POST" || o.Method == "PATCH") {
			body = strings.NewReader(*o.Body)
		}
		req, err := http.NewRequestWithContext(ctx, o.Method, u.String(), body)
		if err != nil {
			return nil, err
		}
		req.Header.Set("User-Agent", botUserAgent())
		for k, v := range o.Headers {
			req.Header.Set(k, v)
		}
		sent := time.Now()
		res, err := client.Do(req)
		if err != nil {
			return nil, unwrapURLError(err)
		}
		ttfb := int(time.Since(sent).Milliseconds())

		loc := res.Header.Get("Location")
		if (o.Method == "GET" || o.Method == "HEAD") && res.StatusCode >= 300 && res.StatusCode < 400 && loc != "" {
			_ = res.Body.Close()
			next, err := u.Parse(loc)
			if err != nil {
				return nil, blocked("Unreadable redirect")
			}
			u = next
			continue
		}

		out := &FetchResult{Status: res.StatusCode, Headers: map[string]string{}, FinalURL: u.String(), TTFBMs: ttfb}
		for k, v := range res.Header {
			if strings.EqualFold(k, "Set-Cookie") {
				out.SetCookie = v
				continue
			}
			out.Headers[strings.ToLower(k)] = strings.Join(v, ", ")
		}
		if o.Method != "HEAD" {
			b, _ := io.ReadAll(io.LimitReader(res.Body, int64(o.MaxBody)))
			out.Body = string(b)
		}
		_ = res.Body.Close()
		out.TotalMs = int(time.Since(started).Milliseconds())
		return out, nil
	}
	return nil, fmt.Errorf("Too many redirects (>%d)", o.MaxRedirects)
}

func unwrapURLError(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
