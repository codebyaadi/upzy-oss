import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { decrypt, decryptJson, encrypt, encryptJson, signWebhook, verifyWebhook } from "../src";

const key = randomBytes(32).toString("base64");

test("encrypt/decrypt round-trips and is non-deterministic", () => {
  const a = encrypt("hello", key);
  expect(a).not.toContain("hello");
  expect(a).not.toBe(encrypt("hello", key));
  expect(decrypt(a, key)).toBe("hello");
  expect(decryptJson<{ x: number }>(encryptJson({ x: 1 }, key), key)).toEqual({ x: 1 });
});

test("wrong key or tampered ciphertext fails", () => {
  const c = encrypt("secret", key);
  expect(() => decrypt(c, randomBytes(32).toString("base64"))).toThrow();
  const tampered = c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA");
  expect(() => decrypt(tampered, key)).toThrow();
});

test("rejects a key of the wrong length", () => {
  expect(() => encrypt("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
});

test("webhook signatures verify, and reject tampering and replays", () => {
  const sig = signWebhook("s3cret", '{"a":1}', 1000);
  expect(verifyWebhook("s3cret", '{"a":1}', sig, 300, 1100)).toBe(true);
  expect(verifyWebhook("s3cret", '{"a":2}', sig, 300, 1100)).toBe(false);
  expect(verifyWebhook("other", '{"a":1}', sig, 300, 1100)).toBe(false);
  expect(verifyWebhook("s3cret", '{"a":1}', sig, 300, 2000)).toBe(false);
});
