/**
 * Who the legal pages speak for. Read at request time (the pages are dynamic), so an operator sets these in the
 * server's environment instead of rebuilding the image.
 */
export const legal = () => ({
  /** The person or company running this Upzy. Set LEGAL_ENTITY to your legal name. */
  entity: process.env.LEGAL_ENTITY?.trim() || "codebyaadi",
  /** A mailbox people can write to. Without CONTACT_EMAIL the pages point to the GitHub profile instead. */
  email: process.env.CONTACT_EMAIL?.trim() || null,
  /** Optional, e.g. "India". Without it the terms don't name a governing law. */
  jurisdiction: process.env.LEGAL_JURISDICTION?.trim() || null,
  /**
   * EARLY_ACCESS=true: every feature is free and unlimited, nothing can be bought yet. The pricing page and the Terms
   * say so instead of offering plans that cannot be paid for.
   */
  earlyAccess: process.env.EARLY_ACCESS?.trim().toLowerCase() === "true",
  updated: "30 October 2026",
});

export const DOCS = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/acceptable-use", label: "Acceptable Use" },
  { href: "/ai-data", label: "AI data use" },
  { href: "/dpa", label: "Data processing" },
  { href: "/bot", label: "UpzyBot" },
] as const;
