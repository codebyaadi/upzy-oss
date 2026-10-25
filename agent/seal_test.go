package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type sealedFixture struct {
	PrivateKey string            `json:"privateKey"`
	PublicKey  string            `json:"publicKey"`
	JobID      string            `json:"jobId"`
	Secrets    map[string]string `json:"secrets"`
	Sealed     Sealed            `json:"sealed"`
}

func loadFixture(t *testing.T) sealedFixture {
	t.Helper()
	b, err := os.ReadFile("testdata/sealed.json")
	if err != nil {
		t.Fatal(err)
	}
	var f sealedFixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// The box was made by the server's TypeScript. If this fails the two sides no longer agree on the scheme.
func TestOpensABoxSealedByTheServer(t *testing.T) {
	f := loadFixture(t)
	seed, _ := base64.StdEncoding.DecodeString(f.PrivateKey)
	k, err := keyPairFromSeed(seed)
	if err != nil {
		t.Fatal(err)
	}
	if k.PublicKey() != f.PublicKey {
		t.Fatalf("the key derived from the private seed differs: %s vs %s", k.PublicKey(), f.PublicKey)
	}
	got, err := k.Open(&f.Sealed, f.JobID)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, f.Secrets) {
		t.Fatalf("got %v want %v", got, f.Secrets)
	}
}

func TestARefusesTheWrongKeyJobOrAlteredBox(t *testing.T) {
	f := loadFixture(t)
	seed, _ := base64.StdEncoding.DecodeString(f.PrivateKey)
	k, _ := keyPairFromSeed(seed)

	other, _ := newKeyPair()
	if _, err := other.Open(&f.Sealed, f.JobID); err == nil {
		t.Error("another agent's key must not open it")
	}
	if _, err := k.Open(&f.Sealed, "11111111-1111-4111-8111-111111111111"); err == nil {
		t.Error("a box made for one job must not open under another")
	}
	ct, _ := base64.StdEncoding.DecodeString(f.Sealed.Ciphertext)
	ct[0] ^= 1
	altered := f.Sealed
	altered.Ciphertext = base64.StdEncoding.EncodeToString(ct)
	if _, err := k.Open(&altered, f.JobID); err == nil {
		t.Error("an altered box must not open")
	}
	if _, err := k.Open(&Sealed{EPK: "!!", Nonce: "x", Ciphertext: "y"}, f.JobID); err == nil {
		t.Error("garbage must be refused, not crash")
	}
}

func TestEachAgentRunHasItsOwnKey(t *testing.T) {
	a, _ := newKeyPair()
	b, _ := newKeyPair()
	if a.PublicKey() == b.PublicKey() {
		t.Fatal("keys must be fresh")
	}
	if raw, _ := base64.StdEncoding.DecodeString(a.PublicKey()); len(raw) != 32 {
		t.Fatalf("a public key is 32 bytes, got %d", len(raw))
	}
}
