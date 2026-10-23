import type { Metadata } from "next";

/** The public address of the website, set at build time (NEXT_PUBLIC_SITE_URL). No trailing slash. */
export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001").replace(
  /\/$/,
  "",
);

export const SITE_NAME = "Upzy";
export const REPO_URL = "https://github.com/codebyaadi/upzy-oss";
export const AUTHOR = { name: "Aditya Rajbhar", url: "https://github.com/codebyaadi" };

/** One line that says what Upzy is. Used for the page description, link previews and structured data. */
export const TAGLINE = "Uptime monitoring and external attack-surface security for small teams.";

/** Sample of what people search for, used for the keywords hint and the page copy. Search engines mostly ignore it. */
export const KEYWORDS = [
  "uptime monitoring",
  "website monitoring",
  "status page",
  "security headers checker",
  "SSL certificate checker",
  "SPF DMARC checker",
  "attack surface management",
  "open source uptime monitor",
  "incident alerts",
];

/** The share image (app/opengraph-image.tsx). A page that sets its own openGraph has to name it, or it gets none. */
const SHARE_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Upzy: uptime monitoring and attack-surface security",
};

/** Page-level metadata that keeps the canonical address, social preview and robots hint consistent. */
export function pageMetadata(opts: {
  title: string;
  description: string;
  /** Path on this site, starting with "/". */
  path: string;
  /** Keep the page out of search results. */
  noindex?: boolean;
}): Metadata {
  return {
    title: opts.title,
    description: opts.description,
    alternates: { canonical: opts.path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      title: opts.title,
      description: opts.description,
      url: opts.path,
      locale: "en_US",
      images: [SHARE_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title: opts.title,
      description: opts.description,
      images: [SHARE_IMAGE.url],
    },
    ...(opts.noindex ? { robots: { index: false, follow: false } } : {}),
  };
}

/** Serialises structured data for a <script type="application/ld+json"> tag, safe against "</script>" in the text. */
export const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
