import { describe, expect, test } from "bun:test";

import { memoryCache, runChecks, type Deps, type VulnDeps } from "../src";
import { SERVICE_PROBES, parseBanner, servicesCheck } from "../src/checks/services";

/** A MySQL/MariaDB handshake as sent by the server: 3-byte length, sequence 0, protocol 10, version, NUL, then more. */
const handshake = (version: string) =>
  Buffer.concat([
    Buffer.from([0x4a, 0x00, 0x00, 0x00, 0x0a]),
    Buffer.from(`${version}\0`, "latin1"),
    Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x5b, 0x7a, 0x30]),
  ]).toString("latin1");

const parsed = (port: number, banner: string) => {
  const m = parseBanner(port, banner);
  return m && `${m.component.product}@${m.component.version}`;
};

describe("parseBanner", () => {
  test("SSH names OpenSSH and keeps the portable-release suffix as part of the version", () => {
    expect(parsed(22, "SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5\r\n")).toBe("openssh@8.2p1");
    expect(parsed(22, "SSH-2.0-OpenSSH_9.6\r\n")).toBe("openssh@9.6");
    const m = parseBanner(22, "SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5\r\n")!;
    expect(m.component.lookup).toEqual({
      kind: "nvd",
      cpe: "cpe:2.3:a:openbsd:openssh:8.2:p1:*:*:*:*:*:*",
    });
    expect(m.component.detectedFrom).toBe(
      "banner on port 22: SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5",
    );
  });

  test("FTP servers that put their version in the greeting", () => {
    expect(parsed(21, "220 ProFTPD 1.3.5e Server (Debian) [::ffff:10.0.0.1]\r\n")).toBe(
      "proftpd@1.3.5e",
    );
    expect(parsed(21, "220 (vsFTPd 3.0.3)\r\n")).toBe("vsftpd@3.0.3");
  });

  test("SMTP names Exim's version; Postfix says none, so nothing is guessed", () => {
    expect(
      parsed(25, "220 mail.example.com ESMTP Exim 4.94.2 Tue, 01 Jan 2030 00:00:00 +0000\r\n"),
    ).toBe("exim@4.94.2");
    expect(parsed(25, "220 mail.example.com ESMTP Postfix (Ubuntu)\r\n")).toBeNull();
    expect(parsed(587, "220 mx ESMTP Exim 4.96\r\n")).toBe("exim@4.96");
  });

  test("MySQL and MariaDB from the handshake, including MariaDB's compatibility prefix", () => {
    expect(parsed(3306, handshake("5.7.33-0ubuntu0.18.04.1"))).toBe("mysql@5.7.33");
    expect(parsed(3306, handshake("5.5.5-10.3.27-MariaDB-0+deb10u1"))).toBe("mariadb@10.3.27");
    expect(parsed(3306, handshake("10.5.12-MariaDB"))).toBe("mariadb@10.5.12");
  });

  test("a MySQL error packet or a closed greeting names nothing", () => {
    expect(parsed(3306, "\x45\x00\x00\x00\xffj\x04Host 'x' is not allowed to connect")).toBeNull();
    expect(parsed(3306, "")).toBeNull();
  });

  test("Redis and Memcached answer the one command with their version", () => {
    expect(
      parsed(6379, "$300\r\n# Server\r\nredis_version:6.0.9\r\nredis_mode:standalone\r\n"),
    ).toBe("redis@6.0.9");
    expect(parsed(6379, "-NOAUTH Authentication required.\r\n")).toBeNull();
    expect(parsed(11211, "VERSION 1.6.9\r\n")).toBe("memcached@1.6.9");
  });

  test("other software and other ports are not claimed", () => {
    expect(parsed(22, "SSH-2.0-dropbear_2020.81\r\n")).toBeNull();
    expect(parsed(80, "SSH-2.0-OpenSSH_8.2p1\r\n")).toBeNull();
  });

  test("a banner with control characters is shown as plain text", () => {
    const m = parseBanner(21, "220 ProFTPD 1.3.5e Server\x1b[31m red\r\n")!;
    expect(m.component.detectedFrom).not.toContain("\x1b");
  });

  test("only the commands that read a version are ever sent", () => {
    expect(SERVICE_PROBES.filter((p) => p.send).map((p) => p.send)).toEqual([
      "INFO server\r\n",
      "version\r\n",
    ]);
  });
});

const scripted = (routes: Record<string, unknown>) => {
  const calls: string[] = [];
  const vuln: VulnDeps = {
    cache: memoryCache(),
    sleep: async () => {},
    http: async (url) => {
      calls.push(url);
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new Error(`unexpected request ${url}`);
      const v = routes[key];
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { vuln, calls };
};

const nvd = (cves: object[]) => ({
  totalResults: cves.length,
  vulnerabilities: cves.map((cve) => ({ cve })),
});
const cve = (id: string, sev: string, score: number) => ({
  id,
  descriptions: [{ lang: "en", value: `desc ${id}` }],
  metrics: { cvssMetricV31: [{ cvssData: { baseScore: score, baseSeverity: sev } }] },
});

const depsWith = (banners: Record<number, string>, vuln: VulnDeps, asked: number[] = []): Deps => ({
  fetch: async () => {
    throw new Error("no web in this test");
  },
  resolveTxt: async () => [],
  resolveMx: async () => [],
  resolveCname: async () => [],
  resolveAddresses: async () => ["1.2.3.4"],
  resolveCaa: async () => [{}],
  tlsLegacy: async () => false,
  tcpOpen: async () => false,
  grabBanner: async (_host, port) => {
    asked.push(port);
    return banners[port] ?? null;
  },
  tls: async () => {
    throw new Error("no tls in this test");
  },
  vuln,
});

describe("services check", () => {
  test("a fixture SSH banner yields a versioned finding with its CVEs, boosted when one is exploited", async () => {
    const { vuln, calls } = scripted({
      "nvd.nist.gov": nvd([cve("CVE-2020-15778", "HIGH", 7.8), cve("CVE-2021-41617", "HIGH", 7.0)]),
      "cisa.gov": { vulnerabilities: [{ cveID: "CVE-2020-15778" }] },
      "first.org": { data: [{ cve: "CVE-2020-15778", epss: "0.4" }] },
    });
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      {
        verified: true,
        checks: [servicesCheck],
        deps: depsWith({ 22: "SSH-2.0-OpenSSH_8.2p1 Ubuntu-4ubuntu0.5\r\n" }, vuln),
      },
    );
    expect(r.outcomes.services).toBe("ok");
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.checkKey).toBe("services.vulnerable_service");
    expect(f.subject).toBe("openssh@8.2p1:22");
    expect(f.title).toBe(
      "OpenSSH 8.2p1 (port 22) has 2 known vulnerabilities (1 exploited in the wild)",
    );
    expect(f.severity).toBe("high");
    expect(f.risk).toEqual({ kev: true, epss: 0.4 });
    expect(f.description).toContain("backport");
    const ev = f.evidence as {
      port: number;
      version: string;
      total: number;
      cves: { id: string }[];
    };
    expect(ev).toMatchObject({ port: 22, version: "8.2p1", total: 2 });
    expect(ev.cves[0]!.id).toBe("CVE-2020-15778");
    expect(
      calls.some((u) =>
        u.includes(encodeURIComponent("cpe:2.3:a:openbsd:openssh:8.2:p1:*:*:*:*:*:*")),
      ),
    ).toBe(true);
  });

  test("two services give two findings, filed per port", async () => {
    const { vuln } = scripted({
      "nvd.nist.gov": nvd([cve("CVE-2019-0001", "MEDIUM", 5)]),
      "cisa.gov": { vulnerabilities: [] },
      "first.org": { data: [] },
    });
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      {
        verified: true,
        checks: [servicesCheck],
        deps: depsWith(
          {
            22: "SSH-2.0-OpenSSH_7.4p1\r\n",
            21: "220 (vsFTPd 3.0.3)\r\n",
            25: "220 mx ESMTP Postfix\r\n",
          },
          vuln,
        ),
      },
    );
    expect(r.findings.map((f) => f.subject).sort()).toEqual([
      "openssh@7.4p1:22",
      "vsftpd@3.0.3:21",
    ]);
  });

  test("a version with no known CVEs is no finding, and silent or unversioned ports cost no lookups", async () => {
    const { vuln, calls } = scripted({
      "nvd.nist.gov": nvd([]),
    });
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      {
        verified: true,
        checks: [servicesCheck],
        deps: depsWith({ 22: "SSH-2.0-OpenSSH_9.9\r\n", 25: "220 mx ESMTP Postfix\r\n" }, vuln),
      },
    );
    expect(r.findings).toEqual([]);
    expect(r.outcomes.services).toBe("ok");
    expect(calls).toHaveLength(1);
  });

  test("a failed lookup marks the family as errored so nothing is auto-resolved", async () => {
    const { vuln } = scripted({ "nvd.nist.gov": new Error("HTTP 429 from services.nvd.nist.gov") });
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      {
        verified: true,
        checks: [servicesCheck],
        deps: depsWith({ 22: "SSH-2.0-OpenSSH_8.2p1\r\n" }, vuln),
      },
    );
    expect(r.outcomes.services).toBe("error");
    expect(r.findings).toEqual([]);
  });

  test("never runs, and never connects, for an asset that is not verified", async () => {
    const { vuln } = scripted({});
    const asked: number[] = [];
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      {
        verified: false,
        checks: [servicesCheck],
        deps: depsWith({ 22: "SSH-2.0-OpenSSH_8.2p1\r\n" }, vuln, asked),
      },
    );
    expect(r.outcomes.services).toBe("skipped");
    expect(asked).toEqual([]);
  });

  test("a banner that cannot be read is not an error", async () => {
    const { vuln } = scripted({});
    const deps = depsWith({}, vuln);
    deps.grabBanner = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await runChecks(
      { kind: "domain", value: "example.com" },
      { verified: true, checks: [servicesCheck], deps },
    );
    expect(r.outcomes.services).toBe("ok");
    expect(r.findings).toEqual([]);
  });
});
