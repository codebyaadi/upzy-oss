import type { Check, FindingDraft, Severity } from "../types";

/*
 * Active checks send more traffic than a visit to the home page, so they run only for assets whose ownership the
 * customer has proved. Findings never include what was read, only where: a leaked file may hold secrets.
 */

interface ExposedPath {
  path: string;
  title: string;
  severity: Severity;
  /** The file's own contents must look like this, so a custom 404 page that answers 200 is not a finding. */
  looksLike: RegExp;
  why: string;
  fix: string;
}

const REMOVE =
  "Remove the file from the web root, or deny the path in your web server configuration.";

export const EXPOSED_PATHS: ExposedPath[] = [
  {
    path: "/.env",
    title: "Environment file is public",
    severity: "critical",
    looksLike: /^\s*[A-Z][A-Z0-9_]{2,}\s*=/m,
    why: "A .env file usually holds database passwords and API keys. Anyone can download them.",
    fix: `${REMOVE} Then rotate every secret that was in it.`,
  },
  {
    path: "/.git/HEAD",
    title: "Git repository is public",
    severity: "critical",
    looksLike: /^ref: refs\/|^[0-9a-f]{40}\s*$/m,
    why: "The .git folder lets anyone download the full source code and its history, which often includes old secrets.",
    fix: `${REMOVE} Deploy built files only, and rotate any secret that was ever committed.`,
  },
  {
    path: "/.git/config",
    title: "Git configuration is public",
    severity: "high",
    looksLike: /^\[core\]/m,
    why: "The git config can reveal the repository address and embedded access tokens.",
    fix: REMOVE,
  },
  {
    path: "/.svn/entries",
    title: "Subversion metadata is public",
    severity: "high",
    looksLike: /^\d+\s*$|dir\s*$/m,
    why: "Exposes the project's file list and can allow downloading its source.",
    fix: REMOVE,
  },
  {
    path: "/.DS_Store",
    title: "macOS folder listing is public",
    severity: "low",
    looksLike: /Bud1/,
    why: "Lists file names in the folder, including ones that were not meant to be linked.",
    fix: REMOVE,
  },
  {
    path: "/phpinfo.php",
    title: "phpinfo() page is public",
    severity: "high",
    looksLike: /PHP Version|phpinfo\(\)/,
    why: "Reveals server paths, PHP settings and environment values.",
    fix: REMOVE,
  },
  {
    path: "/server-status",
    title: "Apache server status is public",
    severity: "medium",
    looksLike: /Apache Server Status/,
    why: "Shows live requests, including visitors' addresses and the pages they open.",
    fix: "Restrict /server-status to localhost or your own network in the Apache configuration.",
  },
  {
    path: "/actuator/env",
    title: "Spring Boot environment endpoint is public",
    severity: "critical",
    looksLike: /"propertySources"|"activeProfiles"/,
    why: "Exposes configuration properties, which commonly include credentials.",
    fix: "Set management.endpoints.web.exposure.include to the endpoints you need (usually just health) and put the rest behind authentication.",
  },
  {
    path: "/actuator/heapdump",
    title: "Spring Boot heap dump is public",
    severity: "critical",
    looksLike: /^JAVA PROFILE|^HPROF/,
    why: "A heap dump contains everything in memory, including sessions and passwords.",
    fix: "Disable the heapdump endpoint and put the management endpoints behind authentication.",
  },
  {
    path: "/wp-config.php.bak",
    title: "WordPress configuration backup is public",
    severity: "critical",
    looksLike: /DB_PASSWORD|DB_NAME/,
    why: "Contains the database name, user and password, in plain text.",
    fix: `${REMOVE} Then change the database password.`,
  },
  {
    path: "/wp-config.php~",
    title: "WordPress configuration backup is public",
    severity: "critical",
    looksLike: /DB_PASSWORD|DB_NAME/,
    why: "Contains the database name, user and password, in plain text.",
    fix: `${REMOVE} Then change the database password.`,
  },
  {
    path: "/config.json",
    title: "Configuration file is public",
    severity: "medium",
    looksLike: /"(?:password|secret|api[_-]?key|token|private[_-]?key)"\s*:/i,
    why: "The file contains values that look like credentials.",
    fix: `${REMOVE} Rotate anything that was in it.`,
  },
  {
    path: "/backup.sql",
    title: "Database dump is public",
    severity: "critical",
    looksLike: /CREATE TABLE|INSERT INTO|-- MySQL dump|PostgreSQL database dump/i,
    why: "A database dump contains your data, often including password hashes.",
    fix: `${REMOVE} Treat the data as leaked.`,
  },
  {
    path: "/dump.sql",
    title: "Database dump is public",
    severity: "critical",
    looksLike: /CREATE TABLE|INSERT INTO|-- MySQL dump|PostgreSQL database dump/i,
    why: "A database dump contains your data, often including password hashes.",
    fix: `${REMOVE} Treat the data as leaked.`,
  },
  {
    path: "/id_rsa",
    title: "Private SSH key is public",
    severity: "critical",
    looksLike: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
    why: "Anyone can use the key to sign in wherever it is accepted.",
    fix: `${REMOVE} Remove the key from every server that trusts it and make a new one.`,
  },
  {
    path: "/.aws/credentials",
    title: "AWS credentials file is public",
    severity: "critical",
    looksLike: /aws_access_key_id|aws_secret_access_key/i,
    why: "Gives anyone access to your AWS account with the key's permissions.",
    fix: `${REMOVE} Deactivate the keys in IAM and issue new ones.`,
  },
  {
    path: "/debug/pprof/",
    title: "Go profiler is public",
    severity: "medium",
    looksLike: /Types of profiles available|\/debug\/pprof\//,
    why: "Exposes internals of the running process and allows heavy profiling requests.",
    fix: "Serve pprof only on a private port, or behind authentication.",
  },
  {
    path: "/_profiler/",
    title: "Symfony profiler is public",
    severity: "high",
    looksLike: /Symfony Profiler/i,
    why: "Shows requests, configuration, queries and environment values.",
    fix: "Turn the profiler off in production (APP_ENV=prod, APP_DEBUG=0).",
  },
  {
    path: "/telescope",
    title: "Laravel Telescope is public",
    severity: "high",
    looksLike: /Laravel Telescope/i,
    why: "Shows requests, queries, mail, jobs and exceptions to anyone.",
    fix: "Gate Telescope in production, or do not install it there.",
  },
];

/** Fetches a few at a time: polite to the site and quick enough for a scan. */
async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export const exposedPathsCheck: Check = {
  family: "exposure",
  active: true,
  appliesTo: ["domain", "subdomain", "url"],
  timeoutMs: 90_000,
  async run({ url, deps }) {
    const origin = new URL(url).origin;
    const results = await inBatches(EXPOSED_PATHS, 4, async (p) => {
      try {
        const res = await deps.fetch(origin + p.path, { maxBodyBytes: 20_000, maxRedirects: 0 });
        // Redirects (to a login page, or http to https) are not exposure; only the file itself is.
        return res.status === 200 && p.looksLike.test(res.body) ? p : null;
      } catch {
        return null;
      }
    });
    return results
      .filter((p): p is ExposedPath => p !== null)
      .map((p): FindingDraft => ({
        checkKey: "exposure.path",
        subject: p.path,
        severity: p.severity,
        title: `${p.title} (${p.path})`,
        description: p.why,
        remediation: p.fix,
        evidence: { path: p.path },
      }));
  },
};

interface RiskyPort {
  port: number;
  name: string;
  severity: Severity;
  why: string;
}

const NO_INTERNET = "should only be reachable from your own servers, never from the internet.";

export const RISKY_PORTS: RiskyPort[] = [
  { port: 21, name: "FTP", severity: "medium", why: "FTP sends passwords in plain text." },
  { port: 23, name: "Telnet", severity: "high", why: "Telnet sends everything in plain text." },
  { port: 445, name: "SMB", severity: "high", why: `File sharing ${NO_INTERNET}` },
  { port: 1433, name: "Microsoft SQL Server", severity: "high", why: `A database ${NO_INTERNET}` },
  {
    port: 2375,
    name: "Docker API",
    severity: "critical",
    why: "The unauthenticated Docker API gives full control of the host.",
  },
  { port: 3306, name: "MySQL", severity: "high", why: `A database ${NO_INTERNET}` },
  {
    port: 3389,
    name: "Remote Desktop",
    severity: "high",
    why: "RDP is a favourite target for password guessing and ransomware.",
  },
  { port: 5432, name: "PostgreSQL", severity: "high", why: `A database ${NO_INTERNET}` },
  {
    port: 5900,
    name: "VNC",
    severity: "high",
    why: "Remote screen access is weakly protected and often has no password.",
  },
  {
    port: 6379,
    name: "Redis",
    severity: "critical",
    why: "Redis usually has no password, and attackers use it to take over servers.",
  },
  {
    port: 9200,
    name: "Elasticsearch",
    severity: "critical",
    why: "Often open without a password, exposing every index.",
  },
  {
    port: 11211,
    name: "Memcached",
    severity: "high",
    why: "Exposes cached data and is abused for traffic amplification attacks.",
  },
  {
    port: 27017,
    name: "MongoDB",
    severity: "critical",
    why: "Open MongoDB servers are routinely wiped and held for ransom.",
  },
];

export const portsCheck: Check = {
  family: "ports",
  active: true,
  appliesTo: ["domain", "subdomain", "url"],
  timeoutMs: 30_000,
  async run({ host, deps }) {
    const open = await Promise.all(
      RISKY_PORTS.map(async (p) => ((await deps.tcpOpen(host, p.port)) ? p : null)),
    );
    return open
      .filter((p): p is RiskyPort => p !== null)
      .map((p): FindingDraft => ({
        checkKey: "ports.exposed_service",
        subject: String(p.port),
        severity: p.severity,
        title: `${p.name} is open to the internet (port ${p.port})`,
        description: p.why,
        remediation: `Block port ${p.port} in your firewall or security group, and allow it only from the addresses that need it (or use a VPN or SSH tunnel).`,
        evidence: { port: p.port, service: p.name },
      }));
  },
};
