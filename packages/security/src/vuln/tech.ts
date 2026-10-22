import type { Component } from "./types";

const cpeEscape = (v: string) => v.replace(/[^A-Za-z0-9._-]/g, (c) => `\\${c}`);
const nvd = (vendor: string, product: string, version: string) =>
  `cpe:2.3:a:${vendor}:${product}:${cpeEscape(version)}:*:*:*:*:*:*:*`;

/** Header product tokens we can map to a CPE. Everything else is ignored: no guessing. */
const SERVER_PRODUCTS: Record<string, { display: string; vendor: string; product: string }> = {
  nginx: { display: "nginx", vendor: "f5", product: "nginx" },
  apache: { display: "Apache HTTP Server", vendor: "apache", product: "http_server" },
  php: { display: "PHP", vendor: "php", product: "php" },
  openssl: { display: "OpenSSL", vendor: "openssl", product: "openssl" },
};

/** Front-end libraries recognised from script URLs, mapped to their npm package. */
const JS_LIBS: { name: string; npm: string; display: string }[] = [
  { name: "jquery", npm: "jquery", display: "jQuery" },
  { name: "bootstrap", npm: "bootstrap", display: "Bootstrap" },
  { name: "angular", npm: "angular", display: "AngularJS" },
  { name: "lodash", npm: "lodash", display: "Lodash" },
  { name: "moment", npm: "moment", display: "Moment.js" },
  { name: "vue", npm: "vue", display: "Vue" },
  { name: "handlebars", npm: "handlebars", display: "Handlebars" },
  { name: "underscore", npm: "underscore", display: "Underscore.js" },
  { name: "dompurify", npm: "dompurify", display: "DOMPurify" },
  { name: "marked", npm: "marked", display: "marked" },
];

const VERSION = String.raw`v?(\d+\.\d+(?:\.\d+)?(?:\.\d+)?)`;

function fromHeaders(headers: Record<string, string>): Component[] {
  const out: Component[] = [];
  for (const header of ["server", "x-powered-by"] as const) {
    const value = headers[header];
    if (!value) continue;
    for (const m of value.matchAll(/([A-Za-z][\w.-]*)\/(\d+(?:\.\d+){1,3}[a-z]?)/g)) {
      const spec = SERVER_PRODUCTS[m[1]!.toLowerCase()];
      if (!spec) continue;
      out.push({
        product: spec.product,
        display: spec.display,
        version: m[2]!,
        detectedFrom: `${header === "server" ? "Server" : "X-Powered-By"}: ${m[0]}`,
        lookup: { kind: "nvd", cpe: nvd(spec.vendor, spec.product, m[2]!) },
      });
    }
  }
  return out;
}

function fromGenerator(body: string): Component[] {
  const tag =
    /<meta\b[^>]*\bname=["']generator["'][^>]*>/i.exec(body)?.[0] ??
    /<meta\b[^>]*\bcontent=["'][^"']*["'][^>]*\bname=["']generator["'][^>]*>/i.exec(body)?.[0];
  const content = tag && /\bcontent=["']([^"']+)["']/i.exec(tag)?.[1];
  if (!content) return [];

  const wp = /^WordPress\s+(\d+\.\d+(?:\.\d+)?)/i.exec(content);
  if (wp)
    return [
      {
        product: "wordpress",
        display: "WordPress",
        version: wp[1]!,
        detectedFrom: `meta generator: ${content}`,
        lookup: { kind: "nvd", cpe: nvd("wordpress", "wordpress", wp[1]!) },
      },
    ];
  // "Drupal 9" carries only a major version, which is too coarse to match CVEs against.
  const dr = /^Drupal\s+(\d+\.\d+(?:\.\d+)?)/i.exec(content);
  if (dr)
    return [
      {
        product: "drupal",
        display: "Drupal",
        version: dr[1]!,
        detectedFrom: `meta generator: ${content}`,
        lookup: { kind: "nvd", cpe: nvd("drupal", "drupal", dr[1]!) },
      },
    ];
  return [];
}

function fromScripts(body: string): Component[] {
  const out: Component[] = [];
  for (const m of body.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
    const src = m[1]!;
    for (const lib of JS_LIBS) {
      // matches jquery-3.4.1.min.js, /jquery/3.4.1/jquery.min.js and jquery@3.4.1
      const hit =
        new RegExp(
          String.raw`(?:^|[/@._-])${lib.name}(?:\.js)?[@/_.-]${VERSION}(?=[/._-]|$)`,
          "i",
        ).exec(src) ?? new RegExp(String.raw`/${lib.name}/${VERSION}/`, "i").exec(src);
      if (!hit) continue;
      out.push({
        product: lib.npm,
        display: lib.display,
        version: hit[1]!,
        detectedFrom: `script: ${src.length > 120 ? `${src.slice(0, 117)}...` : src}`,
        lookup: { kind: "osv", ecosystem: "npm", name: lib.npm },
      });
      break;
    }
  }
  return out;
}

/** Finds versioned software on a page. Conservative: only products with an exact version are returned. */
export function detectComponents(res: {
  headers: Record<string, string>;
  body: string;
}): Component[] {
  const seen = new Map<string, Component>();
  for (const c of [
    ...fromHeaders(res.headers),
    ...fromGenerator(res.body),
    ...fromScripts(res.body),
  ]) {
    const key = `${c.product}@${c.version}`;
    if (!seen.has(key)) seen.set(key, c);
  }
  return [...seen.values()];
}
