import dns from "node:dns/promises";
import { connect as tcpConnect } from "node:net";
import { connect } from "node:tls";

import { resolvePublic, safeFetch } from "@upzy/probes";

import { readBanner } from "./banner";
import type { Deps, TlsInfo } from "./types";
import { httpJson, memoryCache } from "./vuln/http";

/** DNS "no such record" outcomes mean absence, not failure. Anything else is a real error. */
export const isNoRecord = (e: unknown) =>
  ["ENOTFOUND", "ENODATA", "NXDOMAIN"].includes((e as { code?: string })?.code ?? "");

const orEmpty = async <T>(p: Promise<T[]>): Promise<T[]> =>
  p.catch((e) => (isNoRecord(e) ? [] : Promise.reject(e)));

async function tlsInfo(host: string): Promise<TlsInfo> {
  const { address } = await resolvePublic(host);
  return new Promise((ok, bad) => {
    const socket = connect(
      { host: address, port: 443, servername: host, rejectUnauthorized: false, timeout: 10_000 },
      () => {
        const cert = socket.getPeerCertificate() as {
          valid_to?: string;
          bits?: number;
          asn1Curve?: string;
          pubkey?: unknown;
        };
        const info: TlsInfo = {
          protocol: socket.getProtocol(),
          authorized: socket.authorized,
          authorizationError: socket.authorizationError
            ? String(
                (socket.authorizationError as { code?: string }).code ?? socket.authorizationError,
              )
            : null,
          validTo: cert.valid_to ? new Date(cert.valid_to) : null,
          keyBits: typeof cert.bits === "number" ? cert.bits : null,
          keyType: cert.asn1Curve ? "EC" : typeof cert.bits === "number" ? "RSA" : null,
        };
        socket.destroy();
        ok(info);
      },
    );
    socket.once(
      "timeout",
      () => (
        socket.destroy(),
        bad(Object.assign(new Error("TLS connection timed out"), { code: "ETIMEDOUT" }))
      ),
    );
    socket.once("error", bad);
  });
}

/** Offers only one old protocol version. A handshake error means "not accepted"; a timeout means "can't tell". */
async function tlsLegacy(host: string, version: "TLSv1" | "TLSv1.1"): Promise<boolean> {
  const { address } = await resolvePublic(host);
  return new Promise((ok, bad) => {
    const socket = connect({
      host: address,
      port: 443,
      servername: host,
      rejectUnauthorized: false,
      minVersion: version,
      maxVersion: version,
      timeout: 10_000,
    });
    socket.once("secureConnect", () => (socket.destroy(), ok(true)));
    socket.once(
      "timeout",
      () => (
        socket.destroy(),
        bad(Object.assign(new Error("TLS connection timed out"), { code: "ETIMEDOUT" }))
      ),
    );
    socket.once(
      "error",
      (e: Error) => (
        socket.destroy(),
        (e as { code?: string }).code === "ETIMEDOUT" ? bad(e) : ok(false)
      ),
    );
  });
}

async function tcpOpen(host: string, port: number): Promise<boolean> {
  const { address } = await resolvePublic(host);
  return new Promise((ok) => {
    const socket = tcpConnect({ host: address, port, timeout: 3_000 });
    const done = (open: boolean) => (socket.destroy(), ok(open));
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function grabBanner(host: string, port: number, send?: string): Promise<string | null> {
  const { address } = await resolvePublic(host);
  return readBanner(address, port, send);
}

export const defaultDeps: Deps = {
  fetch: (url, opts) => safeFetch(url, { timeoutMs: 10_000, ...opts }),
  resolveTxt: (h) => orEmpty(dns.resolveTxt(h)),
  resolveMx: (h) => orEmpty(dns.resolveMx(h)),
  resolveCname: (h) => orEmpty(dns.resolveCname(h)),
  resolveAddresses: async (h) =>
    (await Promise.all([orEmpty(dns.resolve4(h)), orEmpty(dns.resolve6(h))])).flat(),
  resolveCaa: (h) => orEmpty(dns.resolveCaa(h)),
  tls: tlsInfo,
  tlsLegacy,
  tcpOpen,
  grabBanner,
  safeBrowsingKey: process.env.GOOGLE_SAFE_BROWSING_KEY || undefined,
  vuln: { http: httpJson, cache: memoryCache(), nvdApiKey: process.env.NVD_API_KEY },
};
