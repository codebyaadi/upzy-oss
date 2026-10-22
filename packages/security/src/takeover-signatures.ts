/**
 * Curated fingerprints of unclaimed-resource pages. A CNAME to one of these providers that serves
 * the fingerprint can be claimed by an attacker. Extend carefully: a false positive here is a
 * critical finding.
 */
export interface TakeoverSignature {
  provider: string;
  /** CNAME target suffixes that identify the provider. */
  cname: string[];
  /** Text in the HTTP response that means "nobody owns this name". */
  fingerprint: string;
}

export const TAKEOVER_SIGNATURES: TakeoverSignature[] = [
  {
    provider: "GitHub Pages",
    cname: ["github.io"],
    fingerprint: "There isn't a GitHub Pages site here",
  },
  { provider: "Heroku", cname: ["herokuapp.com", "herokudns.com"], fingerprint: "No such app" },
  {
    provider: "AWS S3 website",
    cname: ["s3.amazonaws.com", "s3-website"],
    fingerprint: "NoSuchBucket",
  },
  {
    provider: "Shopify",
    cname: ["myshopify.com"],
    fingerprint: "Sorry, this shop is currently unavailable",
  },
  { provider: "Fastly", cname: ["fastly.net"], fingerprint: "Fastly error: unknown domain" },
  { provider: "Surge.sh", cname: ["surge.sh"], fingerprint: "project not found" },
  {
    provider: "Ghost",
    cname: ["ghost.io"],
    fingerprint: "The thing you were looking for is no longer here",
  },
  { provider: "Bitbucket", cname: ["bitbucket.io"], fingerprint: "Repository not found" },
  {
    provider: "Netlify",
    cname: ["netlify.app", "netlify.com"],
    fingerprint: "Not Found - Request ID",
  },
  {
    provider: "Azure App Service",
    cname: ["azurewebsites.net"],
    fingerprint: "404 Web Site not found",
  },
];

export const matchProvider = (cnameTarget: string) => {
  const t = cnameTarget.toLowerCase().replace(/\.$/, "");
  return TAKEOVER_SIGNATURES.find((s) => s.cname.some((c) => t.endsWith(c) || t.includes(`.${c}`)));
};
