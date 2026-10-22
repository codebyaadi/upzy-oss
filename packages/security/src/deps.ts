import dns from "node:dns/promises";
import { connect } from "node:tls";

import { resolvePublic, safeFetch } from "@upzy/probes";

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

export const defaultDeps: Deps = {
  fetch: (url, opts) => safeFetch(url, { timeoutMs: 10_000, ...opts }),
  resolveTxt: (h) => orEmpty(dns.resolveTxt(h)),
  resolveMx: (h) => orEmpty(dns.resolveMx(h)),
  resolveCname: (h) => orEmpty(dns.resolveCname(h)),
  resolveAddresses: async (h) =>
    (await Promise.all([orEmpty(dns.resolve4(h)), orEmpty(dns.resolve6(h))])).flat(),
  resolveCaa: (h) => orEmpty(dns.resolveCaa(h)),
  tls: tlsInfo,
  vuln: { http: httpJson, cache: memoryCache(), nvdApiKey: process.env.NVD_API_KEY },
};
