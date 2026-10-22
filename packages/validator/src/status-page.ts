import { z } from "zod";

/** Paths the web app itself uses, so a status page can never shadow them. */
export const RESERVED_SLUGS = new Set([
  "admin",
  "api",
  "app",
  "login",
  "sign-up",
  "signup",
  "status",
  "settings",
  "upzy",
  "www",
]);

export const SlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "At least 3 characters")
  .max(40, "At most 40 characters")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, digits and single hyphens only")
  .refine((s) => !RESERVED_SLUGS.has(s), "That address is reserved");

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A public hostname such as status.acme.com: at least two labels, a real-looking TLD, not an IP address. */
export function isPublicHostname(host: string): boolean {
  if (host.length > 253) return false;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return false;
  const tld = labels[labels.length - 1]!;
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]+$/.test(tld);
}

export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine(isPublicHostname, "Enter a domain like status.example.com (no https://, no path)");

// Plain text only: it is shown to the public, and rendered as text (never as HTML).
const text = (max: number) => z.string().trim().max(max);

const Component = z.object({
  monitorId: z.uuid(),
  displayName: text(60).min(1, "Name the component"),
});

const Fields = {
  title: text(80).min(1, "Give the page a title"),
  slug: SlugSchema,
  description: text(300),
  published: z.boolean(),
  notice: text(500),
  noticeKind: z.enum(["info", "maintenance", "incident"]),
  /** The asset whose security grade the public page shows. Null: none. */
  securityAssetId: z.uuid().nullable(),
  components: z
    .array(Component)
    .max(25, "At most 25 components")
    .refine(
      (c) => new Set(c.map((x) => x.monitorId)).size === c.length,
      "A monitor can appear only once",
    ),
};

/** Creating fills in sensible defaults. */
export const CreateStatusPageSchema = z.object({
  workspaceId: z.uuid(),
  title: Fields.title,
  slug: Fields.slug,
  description: Fields.description.default(""),
  published: Fields.published.default(false),
  notice: Fields.notice.default(""),
  noticeKind: Fields.noticeKind.default("info"),
  securityAssetId: Fields.securityAssetId.default(null),
  components: Fields.components,
  // The form sends "" for "no custom domain".
  customDomain: z.preprocess((v) => (v === "" ? undefined : v), DomainSchema.optional()),
});

/**
 * Updating changes only what is sent. No defaults here: a default on a field the request left out would silently
 * overwrite it (unpublishing the page, clearing its description) every time someone edited something else.
 */
export const UpdateStatusPageSchema = z
  .object({
    ...Fields,
    customDomain: z.preprocess((v) => (v === "" ? null : v), DomainSchema.nullable()),
  })
  .partial();
export type StatusPageInput = z.infer<typeof CreateStatusPageSchema>;
