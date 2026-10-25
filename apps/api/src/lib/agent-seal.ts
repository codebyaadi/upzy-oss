import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

import type { AgentSealed } from "@upzy/validator";

/**
 * A monitor's secrets travel to an agent encrypted to that agent's own key, so they are readable only by the process
 * that asked for the check: not by the network between (TLS already covers that), not by logs or proxies on the way,
 * and not by another agent that somehow obtained the job.
 *
 * Scheme (the Go agent implements the same in agent/seal.go):
 *   the agent makes an X25519 key pair at start and sends the public key with each pull;
 *   per job the server makes an ephemeral X25519 pair and derives a key = HKDF-SHA256(X25519 shared secret,
 *   salt none, info "upzy-agent-secrets-v1"); the secrets (JSON) are sealed with AES-256-GCM, a random 12-byte nonce,
 *   and the job id as associated data, so a sealed box cannot be replayed under another job.
 */
const INFO = Buffer.from("upzy-agent-secrets-v1");
// DER prefix of an X25519 SubjectPublicKeyInfo; the 32 raw key bytes follow.
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

const rawPublic = (key: KeyObject) =>
  (key.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);
const publicFromRaw = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

export function sealSecrets(
  secrets: Record<string, string>,
  agentPublicKeyBase64: string,
  jobId: string,
): AgentSealed {
  const agentKey = Buffer.from(agentPublicKeyBase64, "base64");
  if (agentKey.length !== 32) throw new Error("The agent's public key must be 32 bytes");
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: publicFromRaw(agentKey) });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(jobId));
  const ct = Buffer.concat([
    cipher.update(JSON.stringify(secrets), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    epk: rawPublic(eph.publicKey).toString("base64"),
    nonce: nonce.toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

/** The agent's side, in TypeScript: used by tests to prove the two implementations agree. */
export function openSealed(
  sealed: AgentSealed,
  agentPrivateKeyBase64: string,
  jobId: string,
): Record<string, string> {
  const priv = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(agentPrivateKeyBase64, "base64")]),
    format: "der",
    type: "pkcs8",
  });
  const shared = diffieHellman({
    privateKey: priv,
    publicKey: publicFromRaw(Buffer.from(sealed.epk, "base64")),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), INFO, 32));
  const ct = Buffer.from(sealed.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.nonce, "base64"));
  decipher.setAAD(Buffer.from(jobId));
  decipher.setAuthTag(ct.subarray(-16));
  const plain = Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

/** A fresh agent key pair as raw base64 (32-byte private seed and public key), for tests and fixtures. */
export function newAgentKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  return {
    privateKey: (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer)
      .subarray(-32)
      .toString("base64"),
    publicKey: rawPublic(publicKey).toString("base64"),
  };
}
