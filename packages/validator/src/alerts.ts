import z from "zod";

import { hostOfTarget, isBlockedHost } from "./ssrf";

const name = z.string().trim().min(1, { error: "Name is required" }).max(100);
const workspaceId = z.uuid();

const hostUrl = (hosts: string[], pathPrefix?: string) =>
  z
    .url({ protocol: /^https$/ })
    .refine((u) => hosts.includes(new URL(u).hostname), {
      error: `URL must be on ${hosts.join(" or ")}`,
    })
    .refine((u) => !pathPrefix || new URL(u).pathname.startsWith(pathPrefix), {
      error: `URL path must start with ${pathPrefix}`,
    });

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
