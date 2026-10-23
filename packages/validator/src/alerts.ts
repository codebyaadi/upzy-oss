import z from "zod";

import { hostOfTarget, isBlockedHost } from "./ssrf";

const name = z.string().trim().min(1, { error: "Name is required" }).max(100);
const workspaceId = z.uuid();

/** The parts of a URL, or null when it isn't one: a refinement must never throw on bad input. */
const parts = (u: string) => {
  try {
    const x = new URL(u);
    return { host: x.hostname.toLowerCase(), path: x.pathname };
  } catch {
    return null;
  }
};

const hostUrl = (hosts: string[], pathPrefix?: string) =>
  z
    .url({ protocol: /^https$/ })
    .refine((u) => hosts.includes(parts(u)?.host ?? ""), {
      error: `URL must be on ${hosts.join(" or ")}`,
    })
    .refine((u) => !pathPrefix || (parts(u)?.path ?? "").startsWith(pathPrefix), {
      error: `URL path must start with ${pathPrefix}`,
    });

/** An https URL whose host is one of `suffixes` or a subdomain of it (Teams webhooks live on many tenant hosts). */
const hostSuffixUrl = (suffixes: string[], what: string) =>
  z.url({ protocol: /^https$/ }).refine(
    (u) => {
      const host = parts(u)?.host ?? "";
      return host !== "" && suffixes.some((s) => host === s || host.endsWith(`.${s}`));
    },
    { error: `That doesn't look like a ${what} URL` },
  );

export const CreateChannelSchema = z.discriminatedUnion("kind", [
  z.object({ workspaceId, name, kind: z.literal("email"), to: z.email() }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("slack"),
    url: hostUrl(["hooks.slack.com"], "/services/"),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("discord"),
    url: hostUrl(["discord.com", "discordapp.com"], "/api/webhooks/"),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("teams"),
    url: hostSuffixUrl(
      ["webhook.office.com", "outlook.office.com", "logic.azure.com", "powerplatform.com"],
      "Microsoft Teams webhook",
    ),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("pagerduty"),
    /** The 32-character integration key of an Events API v2 integration. */
    routingKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{32}$/, {
        error: "An Events API v2 integration key is 32 letters and digits",
      }),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("opsgenie"),
    apiKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9-]{20,64}$/, { error: "That doesn't look like an Opsgenie API key" }),
    region: z.enum(["us", "eu"]).default("us"),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("github"),
    repo: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/, {
        error: "Use owner/name, like acme/web",
      }),
    token: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{20,255}$/, { error: "That doesn't look like a GitHub token" }),
  }),
  z.object({
    workspaceId,
    name,
    kind: z.literal("webhook"),
    url: z
      .httpUrl()
      .refine((u) => !isBlockedHost(hostOfTarget(u)), { error: "URL must point to a public host" }),
  }),
]);
export type CreateChannelInput = z.infer<typeof CreateChannelSchema>;

export const UpdateChannelSchema = z.object({
  name: name.optional(),
  enabled: z.boolean().optional(),
});

export const IncidentEventSchema = z.enum(["incident.opened", "incident.resolved"]);
/** Everything a rule can subscribe to. `finding.opened` = new or regressed critical/high security finding. */
export const AlertEventSchema = z.enum(["incident.opened", "incident.resolved", "finding.opened"]);

export const CreateAlertRuleSchema = z
  .object({
    workspaceId,
    channelId: z.uuid(),
    /** Omit or null to apply to every monitor in the workspace. */
    monitorId: z.uuid().nullish(),
    events: z
      .array(AlertEventSchema)
      .min(1)
      .max(3)
      .default(["incident.opened", "incident.resolved", "finding.opened"]),
  })
  .refine((r) => !(r.monitorId && r.events.includes("finding.opened")), {
    error: "Security finding alerts are workspace-wide and can't be limited to one monitor",
    path: ["events"],
  });

export const UpdateAlertRuleSchema = z.object({
  events: z.array(AlertEventSchema).min(1).max(3).optional(),
  enabled: z.boolean().optional(),
});
