import { schema, type Db } from "@upzy/db";
import { dnsRecordValue, wellKnownPath } from "@upzy/security";
import { OnboardSiteSchema, parseSite } from "@upzy/validator";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";

import { createAsset } from "../lib/assets";
import type { Billing } from "../lib/billing";
import { requireWorkspace } from "../lib/scope";
import type { AuthPlugin } from "../plugins/auth";
import { HttpError } from "../plugins/errors";

const { assets, monitors } = schema;

/**
 * The shortest path to value: give a website, get uptime monitoring, a certificate-expiry monitor and a passive
 * security scan (which produces the health score). Safe to repeat: whatever already exists is reused, never
 * duplicated, so pressing the button twice or adding the same site later does nothing surprising.
 */
export const onboardingModule = (db: Db, authP: AuthPlugin, billing: Billing) =>
  new Elysia({ prefix: "/onboarding" }).use(authP).post(
    "/site",
    async ({ body, orgId, set }) => {
      await requireWorkspace(db, orgId, body.workspaceId);
      const site = parseSite(body.site);
      if (!site) throw new HttpError(422, "Enter a public website address like example.com");
      const ws = body.workspaceId;

      const findAsset = async () =>
        (
          await db
            .select()
            .from(assets)
            .where(
              and(
                eq(assets.workspaceId, ws),
                eq(assets.kind, site.assetKind),
                eq(assets.value, site.assetValue),
              ),
            )
        )[0];
      const existingAsset = await findAsset();
      let asset: {
        row: { id: string; value: string; kind: string; verified: boolean };
        token: string;
        created: boolean;
      };
      if (existingAsset)
        asset = { row: existingAsset, token: existingAsset.verificationToken, created: false };
      else {
        await billing.assertCanCreate(db, orgId, "assets");
        try {
          asset = {
            ...(await createAsset(db, {
              workspaceId: ws,
              kind: site.assetKind,
              value: site.assetValue,
            })),
            created: true,
          };
        } catch (e) {
          // Two requests raced to add the same site: the other one won, so use its asset.
          const winner = await findAsset();
          if (!winner) throw e;
          asset = { row: winner, token: winner.verificationToken, created: false };
        }
      }

      const ensureMonitor = async (m: {
        type: "http" | "ssl";
        name: string;
        target: string;
        interval: number;
      }) => {
        const [found] = await db
          .select({ id: monitors.id })
          .from(monitors)
          .where(
            and(
              eq(monitors.workspaceId, ws),
              eq(monitors.type, m.type),
              eq(monitors.target, m.target),
            ),
          );
        if (found) return { id: found.id, type: m.type, name: m.name, created: false };
        await billing.assertCanCreate(db, orgId, "monitors");
        await billing.assertInterval(db, orgId, m.interval);
        const [row] = await db
          .insert(monitors)
          .values({ workspaceId: ws, ...m, active: true, config: {}, failureThreshold: 2 })
          .returning({ id: monitors.id });
        return { id: row!.id, type: m.type, name: m.name, created: true };
      };
      // A page every 5 minutes is the usual starting point; a certificate only needs a daily look.
      const created = [
        await ensureMonitor({ type: "http", name: site.host, target: site.url, interval: 300 }),
        await ensureMonitor({
          type: "ssl",
          name: `${site.host} certificate`,
          target: site.host,
          interval: 3600,
        }),
      ];

      // A just-added asset is scanned by the scheduler within seconds; a repeat request asks for a fresh scan,
      // unless one ran in the last few minutes.
      if (
        existingAsset &&
        (!existingAsset.lastScanAt || Date.now() - existingAsset.lastScanAt.getTime() > 5 * 60_000)
      )
        await db.update(assets).set({ nextScanAt: new Date() }).where(eq(assets.id, asset.row.id));

      set.status = 201;
      return {
        asset: {
          id: asset.row.id,
          value: asset.row.value,
          kind: asset.row.kind,
          verified: asset.row.verified,
          created: asset.created,
        },
        monitors: created,
        verification: asset.row.verified
          ? null
          : {
              dns: { type: "TXT", name: "@ (or _upzy)", value: dnsRecordValue(asset.token) },
              file: { path: wellKnownPath, content: asset.token },
            },
      };
    },
    { org: "member", body: OnboardSiteSchema },
  );
