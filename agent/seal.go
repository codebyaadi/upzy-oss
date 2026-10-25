package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
)

// A monitor's secrets reach the agent sealed to the agent's own key, so only this process can read them. The scheme is
// the one in apps/api/src/lib/agent-seal.ts: an X25519 exchange with an ephemeral server key, HKDF-SHA256 (no salt,
// info "upzy-agent-secrets-v1") to get an AES-256-GCM key, the job id as associated data. agent/testdata/sealed.json
// is a box made by the server's code; the tests here open it.

const sealInfo = "upzy-agent-secrets-v1"

// Sealed is the sealedSecrets field of a job (schemas/agent-job.schema.json).
type Sealed struct {
	EPK        string `json:"epk"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

// keyPair is made once when the agent starts; the public half goes to the server with every pull.
type keyPair struct {
	priv *ecdh.PrivateKey
}

func newKeyPair() (*keyPair, error) {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &keyPair{priv: k}, nil
}

func keyPairFromSeed(seed []byte) (*keyPair, error) {
	k, err := ecdh.X25519().NewPrivateKey(seed)
	if err != nil {
		return nil, err
	}
	return &keyPair{priv: k}, nil
}

func (k *keyPair) PublicKey() string {
	return base64.StdEncoding.EncodeToString(k.priv.PublicKey().Bytes())
}

// hkdf32 is HKDF-SHA256 (RFC 5869) with an empty salt, producing 32 bytes: the standard library only has it from
// Go 1.24 and this module supports older toolchains.
func hkdf32(secret []byte, info string) []byte {
	extract := hmac.New(sha256.New, make([]byte, sha256.Size)) // no salt: a block of zeros
	extract.Write(secret)
	expand := hmac.New(sha256.New, extract.Sum(nil))
	expand.Write([]byte(info))
	expand.Write([]byte{1})
	return expand.Sum(nil)
}

// Open decrypts a job's secrets. A wrong key, a changed byte or a box made for another job all fail.
func (k *keyPair) Open(s *Sealed, jobID string) (map[string]string, error) {
	epk, err := base64.StdEncoding.DecodeString(s.EPK)
	if err != nil {
		return nil, errors.New("unreadable sealed secrets")
	}
	nonce, err1 := base64.StdEncoding.DecodeString(s.Nonce)
	ct, err2 := base64.StdEncoding.DecodeString(s.Ciphertext)
	if err1 != nil || err2 != nil {
		return nil, errors.New("unreadable sealed secrets")
	}
	pub, err := ecdh.X25519().NewPublicKey(epk)
	if err != nil {
		return nil, errors.New("unreadable sealed secrets")
	}
	shared, err := k.priv.ECDH(pub)
	if err != nil {
		return nil, errors.New("unreadable sealed secrets")
	}
	block, err := aes.NewCipher(hkdf32(shared, sealInfo))
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	if len(nonce) != gcm.NonceSize() {
		return nil, errors.New("unreadable sealed secrets")
	}
	plain, err := gcm.Open(nil, nonce, ct, []byte(jobID))
	if err != nil {
		return nil, errors.New("the secrets could not be decrypted")
	}
	var out map[string]string
	if err := json.Unmarshal(plain, &out); err != nil {
		return nil, errors.New("unreadable secrets")
	}
	return out, nil
}
