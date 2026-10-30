import type { Check, FindingDraft } from "../types";
import { assessComponents } from "../vuln";
import type { Component } from "../vuln/types";
import { componentFinding } from "./cve";

const cpeEscape = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, (c) => `\\${c}`);
const cpe = (vendor: string, product: string, version: string, update = "*") =>
  `cpe:2.3:a:${vendor}:${product}:${cpeEscape(version)}:${update === "*" ? "*" : cpeEscape(update)}:*:*:*:*:*:*`;

/** A service whose banner named its software and an exact version. */
export interface ServiceMatch {
  component: Component;
  port: number;
}

type Parsed = Omit<Component, "detectedFrom">;

interface ServiceProbe {
  port: number;
  name: string;
  /** One read-only command for services that wait to be spoken to. Greeting-first services need none. */
  send?: string;
  parse(banner: string): Parsed | null;
}

const make = (
  product: string,
  display: string,
  version: string,
  vendor: string,
  cpeVersion = version,
  update?: string,
): Parsed => ({
  product,
  display,
  version,
  lookup: { kind: "nvd", cpe: cpe(vendor, product, cpeVersion, update) },
});

const ssh = (banner: string): Parsed | null => {
  const m = /^SSH-2\.0-OpenSSH_(\d+\.\d+)(?:p(\d+))?/m.exec(banner);
  if (!m) return null;
  return make(
    "openssh",
    "OpenSSH",
    m[2] ? `${m[1]}p${m[2]}` : m[1]!,
    "openbsd",
    m[1],
    m[2] ? `p${m[2]}` : undefined,
  );
};

const ftp = (banner: string): Parsed | null => {
  const pro = /\bProFTPD\s+(\d+\.\d+\.\d+[a-z]?)/i.exec(banner);
  if (pro) return make("proftpd", "ProFTPD", pro[1]!, "proftpd");
  const vs = /\bvsFTPd\s+(\d+\.\d+\.\d+)/i.exec(banner);
  if (vs) return make("vsftpd", "vsftpd", vs[1]!, "vsftpd_project");
  return null;
};

const smtp = (banner: string): Parsed | null => {
  const m = /^220[ -].*\bESMTP Exim (\d+\.\d+(?:\.\d+)?)/m.exec(banner);
  return m ? make("exim", "Exim", m[1]!, "exim") : null;
};

/** The MySQL/MariaDB handshake: a 4-byte packet header, protocol byte 10, then the server version, NUL-ended. */
const mysql = (banner: string): Parsed | null => {
  const m = /^[\s\S]{4}\n([^\0]{3,60})\0/.exec(banner);
  if (!m) return null;
  const raw = m[1]!;
  // MariaDB announces itself as "5.5.5-10.3.27-MariaDB" (the 5.5.5 is a compatibility prefix) or "10.5.12-MariaDB".
  if (/mariadb/i.test(raw)) {
    const v = /(\d+\.\d+\.\d+)(?=-MariaDB)/i.exec(raw)?.[1];
    return v ? make("mariadb", "MariaDB", v, "mariadb") : null;
  }
  const v = /^(\d+\.\d+\.\d+)/.exec(raw)?.[1];
  return v ? make("mysql", "MySQL", v, "oracle") : null;
};

const redis = (banner: string): Parsed | null => {
  const v = /redis_version:(\d+\.\d+\.\d+)/.exec(banner)?.[1];
  return v ? make("redis", "Redis", v, "redis") : null;
};

const memcached = (banner: string): Parsed | null => {
  const v = /^VERSION (\d+\.\d+\.\d+)/m.exec(banner)?.[1];
  return v ? make("memcached", "Memcached", v, "memcached") : null;
};

/** The ports whose software and version we can read. Where nothing says a version, nothing is reported: no guessing. */
export const SERVICE_PROBES: ServiceProbe[] = [
  { port: 21, name: "FTP", parse: ftp },
  { port: 22, name: "SSH", parse: ssh },
  { port: 25, name: "SMTP", parse: smtp },
  { port: 587, name: "SMTP submission", parse: smtp },
  { port: 3306, name: "MySQL", parse: mysql },
  { port: 6379, name: "Redis", send: "INFO server\r\n", parse: redis },
  { port: 11211, name: "Memcached", send: "version\r\n", parse: memcached },
];

/** What the banner showed, printable and short enough to display as evidence. */
export function showBanner(banner: string): string {
  const line = banner
    .split(/\r?\n/)[0]!
    .replace(/[^\x20-\x7e]/g, "")
    .trim();
  return line.length > 100 ? `${line.slice(0, 97)}...` : line;
}

/** Reads a banner and says which software and version it names, if it does. */
export function parseBanner(port: number, banner: string): ServiceMatch | null {
  const probe = SERVICE_PROBES.find((p) => p.port === port);
  const parsed = probe?.parse(banner);
  if (!probe || !parsed) return null;
  const shown =
    probe.port === 3306 || probe.port === 6379 || probe.port === 11211
      ? `${probe.name} handshake`
      : showBanner(banner);
  return {
    port,
    component: { ...parsed, detectedFrom: `banner on port ${port}: ${shown}` },
  };
}

/** The finding for a vulnerable service: the component finding, filed under the service so it resolves on its own. */
export function serviceFinding(
  match: ServiceMatch,
  assessment: Parameters<typeof componentFinding>[0],
): FindingDraft {
  const base = componentFinding(assessment);
  const { component, port } = match;
  return {
    ...base,
    checkKey: "services.vulnerable_service",
    subject: `${component.product}@${component.version}:${port}`,
    title: base.title.replace(" has ", ` (port ${port}) has `),
    evidence: { ...base.evidence, port },
  };
}

/**
 * Reads the greeting of the services an asset exposes (SSH, FTP, SMTP, MySQL, Redis, Memcached), takes the software
 * and version they announce, and reports the known CVEs for it, prioritised by KEV and EPSS like web components.
 * Active: it connects to ports a normal visit would not, so it runs only for verified assets.
 */
export const servicesCheck: Check = {
  family: "services",
  active: true,
  appliesTo: ["domain", "subdomain", "url"],
  // NVD is paced to one request every few seconds without an API key, and each service is one request.
  timeoutMs: 240_000,
  async run({ host, deps }) {
    const seen = new Map<string, ServiceMatch>();
    await Promise.all(
      SERVICE_PROBES.map(async (probe) => {
        const banner = await deps.grabBanner(host, probe.port, probe.send).catch(() => null);
        const match = banner ? parseBanner(probe.port, banner) : null;
        if (match)
          seen.set(`${match.component.product}@${match.component.version}:${probe.port}`, match);
      }),
    );
    if (seen.size === 0) return [];
    const matches = [...seen.values()];
    const assessed = await assessComponents(
      deps.vuln,
      matches.map((m) => m.component),
    );
    return assessed.flatMap((a) =>
      matches.filter((m) => m.component === a.component).map((m) => serviceFinding(m, a)),
    );
  },
};
