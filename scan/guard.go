package main

import (
	"context"
	"fmt"
	"math"
	"net"
	"net/netip"
	"regexp"
	"strconv"
	"strings"
)

// The scanner refuses to scan anything that is not publicly routable, with the same rules as the probe agent (agent/egress.go)
// and packages/probes/src/egress.ts. This is the first layer: the target name is resolved and every address must be
// public. The second is nuclei's own sandbox option, which blocks connections to private networks while it runs.

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
