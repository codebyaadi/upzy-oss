//go:build e2e

package main

// A binary built with `-tags e2e` may scan servers on this machine, so the whole path can be tried against a local
// test site. Release builds are made without the tag and refuse every non-public address.
func init() { allowLocalTargets = true }
