import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createAuth } from "@upzy/auth/server";
import { decryptJson } from "@upzy/crypto";
import { createDb, schema } from "@upzy/db";
import { eq, sql } from "drizzle-orm";

import { createApp } from "../src/app";

// Real Postgres + real better-auth. Needs: DATABASE_URL=... bun test
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

run("rich monitors and heartbeats (postgres)", () => {
  process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-integration-test-secret";
  const db = createDb(url);
  const auth = createAuth(db, {
    sendEmail: async () => {},
    signup: { mode: "open", allowedEmails: [], allowedDomains: [] },
  });
  const tag = `rm${Date.now()}`;
  const origin = "http://localhost:3001";
  const app = createApp({
    db,
    auth,
    webOrigin: origin,
    encryptionKey: Buffer.alloc(32, 4).toString("base64"),
    rateLimit: { rules: [{ match: () => true, bucket: "t", max: Infinity, windowMs: 1 }] },
  });
  const send = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          origin,
          ...(init.cookie ? { cookie: init.cookie } : {}),
        },
      }),
    );
  const json = async (r: Response) => (await r.json()) as any;
  const cookieOf = (r: Response) =>
    r.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const person = async (name: string) => {
    const r = await send("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({
        email: `${tag}-${name}@example.com`,
        password: "supersecret123",
        name,
      }),
    });
    return { cookie: cookieOf(r) };
  };
  const makeOrg = async (who: { cookie: string }, slug: string) => {
    const org = await json(
      await send("/api/auth/organization/create", {
        method: "POST",
        cookie: who.cookie,
        body: JSON.stringify({ name: slug, slug: `${tag}-${slug}` }),
      }),
    );
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({ organizationId: org.id }),
    });
    const [ws] = await db
      .insert(schema.workspaces)
      .values({ orgId: org.id, name: `${slug} ws` })
      .returning({ id: schema.workspaces.id });
    return { orgId: org.id as string, ws: ws!.id };
  };
  const call = (who: { cookie: string }, method: string, path: string, body?: unknown) =>
    send(path, { method, cookie: who.cookie, ...(body ? { body: JSON.stringify(body) } : {}) });

  const KEY = Buffer.alloc(32, 4).toString("base64");
  let owner: { cookie: string }, viewer: { cookie: string }, other: { cookie: string };
  let A = { orgId: "", ws: "" };
  const row = async (id: string) =>
    (await db.select().from(schema.monitors).where(eq(schema.monitors.id, id)))[0]!;
  const make = (body: object, who = owner) =>
    call(who, "POST", "/monitor", { workspaceId: A.ws, name: "m", interval: 300, ...body });
  const http = (over: object = {}) =>
    make({ type: "http", target: `https://${tag}.example.com/health`, ...over });

  beforeAll(async () => {
    owner = await person("owner");
    viewer = await person("viewer");
    other = await person("other");
    A = await makeOrg(owner, "a");
    await makeOrg(other, "b");
    const viewerId = (await json(await call(viewer, "GET", "/api/auth/get-session"))).user.id;
    await auth.api.addMember({
      body: { userId: viewerId, role: "viewer", organizationId: A.orgId },
    });
    await send("/api/auth/organization/set-active", {
      method: "POST",
      cookie: viewer.cookie,
      body: JSON.stringify({ organizationId: A.orgId }),
    });
  });
  afterAll(async () => {
    await db.delete(schema.jobs).where(sql`${schema.jobs.payload}::text like ${`%${A.ws}%`}`);
    await db.delete(schema.organizations).where(eq(schema.organizations.id, A.orgId));
  });

  describe("headers, secrets and JSON checks", () => {
    test("secrets are stored encrypted and only their names are ever returned", async () => {
      const r = await http({
        name: "api",
        config: {
          method: "POST",
          headers: { Authorization: "Bearer {{secret.API_TOKEN}}", "X-App": "ios" },
          body: '{"ping":true}',
          assertions: [{ path: "status", op: "equals", value: "ok" }],
        },
        secrets: { API_TOKEN: "tok_super_secret_1" },
      });
      expect(r.status).toBe(201);
      const created = await json(r);
      expect(created.secretNames).toEqual(["API_TOKEN"]);
      expect(JSON.stringify(created)).not.toContain("tok_super_secret_1");
      expect(created.secretsEncrypted).toBeUndefined();

      const stored = await row(created.id);
      expect(stored.secretsEncrypted).not.toContain("tok_super_secret_1");
      expect(decryptJson<Record<string, string>>(stored.secretsEncrypted!, KEY)).toEqual({
        API_TOKEN: "tok_super_secret_1",
      });
      expect(stored.config.headers).toEqual({
        Authorization: "Bearer {{secret.API_TOKEN}}",
        "X-App": "ios",
      });

      for (const path of [`/monitor/${created.id}`, `/monitor?workspaceId=${A.ws}`]) {
        const text = JSON.stringify(await json(await call(viewer, "GET", path)));
        expect(text).not.toContain("tok_super_secret_1");
        expect(text).not.toContain("secretsEncrypted");
        expect(text).toContain("API_TOKEN");
      }
    });

    test("references to a secret that doesn't exist, a body on GET, and reserved headers are refused", async () => {
      expect(
        (await http({ config: { headers: { Authorization: "{{secret.NOPE}}" } } })).status,
      ).toBe(400);
      expect((await http({ config: { method: "GET", body: "{}" } })).status).toBe(400);
      expect((await http({ config: { headers: { Host: "evil.example" } } })).status).toBe(400);
      expect((await http({ config: { headers: { "X-A": "line\nbreak" } } })).status).toBe(400);
      expect(
        (await http({ config: { method: "HEAD", assertions: [{ path: "a", op: "exists" }] } }))
          .status,
      ).toBe(400);
      expect(
        (await http({ config: { assertions: [{ path: "count", op: "gt", value: "abc" }] } }))
          .status,
      ).toBe(400);
      expect((await http({ secrets: { lowercase: "x" } })).status).toBe(400);
    });

    test("updating secrets: null keeps, a value replaces, a missing name deletes, and nothing may be left dangling", async () => {
      const id = (
        await json(
          await http({
            name: "upd",
            config: { headers: { A: "{{secret.ONE}}", B: "{{secret.TWO}}" } },
            secrets: { ONE: "value-one-111", TWO: "value-two-222" },
          }),
        )
      ).id;
      const patch = (b: object) => call(owner, "PATCH", `/monitor/${id}`, b);
      const secretsOf = async () =>
        decryptJson<Record<string, string>>((await row(id)).secretsEncrypted!, KEY);

      expect((await patch({ secrets: { ONE: null, TWO: "value-two-NEW" } })).status).toBe(200);
      expect(await secretsOf()).toEqual({ ONE: "value-one-111", TWO: "value-two-NEW" });
      expect((await patch({ name: "renamed" })).status).toBe(200); // omitting secrets leaves them alone
      expect(await secretsOf()).toEqual({ ONE: "value-one-111", TWO: "value-two-NEW" });
      // Keeping something that isn't stored, or dropping something still referenced, is refused.
      expect((await patch({ secrets: { GHOST: null, ONE: null, TWO: null } })).status).toBe(422);
      const dangling = await patch({ secrets: { ONE: null } });
      expect(dangling.status).toBe(422);
      expect((await json(dangling)).message).toContain("secret named TWO");
      expect((await patch({ config: { headers: {} }, secrets: {} })).status).toBe(200);
      expect((await row(id)).secretsEncrypted).toBeNull();
    });
  });

  describe("flows", () => {
    const flow = (over: object = {}) =>
      make({
        type: "flow",
        name: "login flow",
        secrets: { PASSWORD: "pw-secret-9" },
        config: {
          steps: [
            {
              name: "Log in",
              method: "POST",
              url: `https://${tag}.example.com/login`,
              body: '{"password":"{{secret.PASSWORD}}"}',
              extract: { token: "data.token" },
            },
            {
              name: "Profile",
              url: `https://${tag}.example.com/me`,
              headers: { Authorization: "Bearer {{token}}" },
              assertions: [{ path: "email", op: "exists" }],
            },
          ],
        },
        ...over,
      });

    test("a flow is created with its first step as the address, defaults filled in, secrets encrypted", async () => {
      const r = await flow();
      expect(r.status).toBe(201);
      const f = await json(r);
      expect(f.target).toBe(`https://${tag}.example.com/login`);
      expect(f.secretNames).toEqual(["PASSWORD"]);
      expect(JSON.stringify(f)).not.toContain("pw-secret-9");
      expect(f.config.steps[1].method).toBe("GET");
      expect(f.config.steps[0].assertions).toEqual([]);
    });

    test("mistakes are caught on creation: unknown variable, private address, host variables, no steps, steps on HTTP", async () => {
      const step = (over: object) => ({ name: "s", url: `https://${tag}.example.com/x`, ...over });
      expect(
        (await flow({ config: { steps: [step({ headers: { A: "{{later}}" } })] } })).status,
      ).toBe(400);
      expect(
        (await flow({ config: { steps: [step({ url: "http://localhost/admin" })] } })).status,
      ).toBe(400);
      expect((await flow({ config: { steps: [step({ url: "http://10.0.0.5/x" })] } })).status).toBe(
        400,
      );
      expect(
        (
          await flow({
            config: { steps: [step({ url: "https://{{secret.PASSWORD}}.example.com/" })] },
          })
        ).status,
      ).toBe(400);
      expect(
        (await flow({ config: { steps: [step({ url: "https://user:pw@api.example.com/" })] } }))
          .status,
      ).toBe(400);
      expect((await flow({ config: { steps: [] } })).status).toBe(400);
      expect((await flow({ config: {} })).status).toBe(400);
      expect((await http({ config: { steps: [step({})] } })).status).toBe(400);
      expect(
        (await flow({ config: { steps: Array.from({ length: 6 }, () => step({})) } })).status,
      ).toBe(400);
      // A variable used in step 1 that only step 2 provides is still unknown.
      expect(
        (
          await flow({
            config: {
              steps: [step({ headers: { A: "{{token}}" } }), step({ extract: { token: "t" } })],
            },
          })
        ).status,
      ).toBe(400);
    });
  });

  describe("heartbeats", () => {
    const beat = (over: object = {}, who = owner) =>
      make({ type: "heartbeat", name: "nightly", config: { expectEvery: 3600 }, ...over }, who);
    let id = "";
    let token = "";

    test("a heartbeat gets a ping address, a one-minute watch, an immediate threshold and a sensible grace", async () => {
      const r = await beat();
      expect(r.status).toBe(201);
      const hb = await json(r);
      id = hb.id;
      expect(hb.pingUrl).toMatch(/^http:\/\/localhost:3000\/ping\/[\w-]{32}$/);
      token = hb.pingUrl.split("/").pop();
      expect(hb).toMatchObject({
        target: "heartbeat",
        interval: 60,
        failureThreshold: 1,
        lastStatus: "unknown",
      });
      expect(hb.config).toEqual({ expectEvery: 3600, grace: 360 });
      expect(hb.heartbeatToken).toBeUndefined();
      // Members see the address; viewers do not, in the list or the detail.
      const detail = await json(await call(viewer, "GET", `/monitor/${id}`));
      expect(detail.pingUrl).toBeNull();
      expect(
        JSON.stringify(await json(await call(viewer, "GET", `/monitor?workspaceId=${A.ws}`))),
      ).not.toContain(token);
      expect((await json(await call(owner, "GET", `/monitor/${id}`))).pingUrl).toContain(token);
      // The list doesn't pretend to know an uptime percentage for it.
      const listed = (await json(await call(owner, "GET", `/monitor?workspaceId=${A.ws}`))).find(
        (m: any) => m.id === id,
      );
      expect(listed.uptime24h).toBeNull();
    });

    test("expectEvery is required, timing options belong only to heartbeats, and headers don't apply", async () => {
      expect((await beat({ config: {} })).status).toBe(400);
      expect((await beat({ config: { expectEvery: 10 } })).status).toBe(400);
      expect((await http({ config: { expectEvery: 3600 } })).status).toBe(400);
      expect((await beat({ config: { expectEvery: 3600, headers: { A: "b" } } })).status).toBe(400);
    });

    test("a ping records the time, works with any method, and the first one after lateness asks for a check now", async () => {
      const ping = (m = "GET", suffix = "") =>
        app.handle(new Request(`http://localhost/ping/${token}${suffix}`, { method: m }));
      const jobs = () =>
        db
          .select()
          .from(schema.jobs)
          .where(
            sql`${schema.jobs.queue} = 'check' and ${schema.jobs.payload}->>'monitorId' = ${id}`,
          );

      expect((await ping("GET")).status).toBe(200);
      const first = (await row(id)).lastPingAt!;
      expect(first).toBeInstanceOf(Date);
      expect(await jobs()).toHaveLength(1); // status was unknown, so check straight away
      await Bun.sleep(1100);
      expect((await ping("POST")).status).toBe(200);
      expect((await row(id)).lastPingAt!.getTime()).toBeGreaterThan(first.getTime());

      // Healthy and pinging often: written at most once a second, no more checks queued.
      await db.update(schema.monitors).set({ lastStatus: "up" }).where(eq(schema.monitors.id, id));
      await db
        .delete(schema.jobs)
        .where(
          sql`${schema.jobs.queue} = 'check' and ${schema.jobs.payload}->>'monitorId' = ${id}`,
        );
      await ping();
      const t1 = (await row(id)).lastPingAt!.getTime();
      await ping();
      expect((await row(id)).lastPingAt!.getTime()).toBe(t1);
      expect(await jobs()).toHaveLength(0);

      // A failure report is recorded and checked immediately.
      expect((await ping("GET", "/fail")).status).toBe(200);
      expect((await row(id)).lastFailAt).toBeInstanceOf(Date);
      expect(await jobs()).toHaveLength(1);
    });

    test("unknown or malformed tokens are 404 or 400, and a paused monitor ignores pings", async () => {
      const get = (t: string) => app.handle(new Request(`http://localhost/ping/${t}`));
      expect((await get("A".repeat(32))).status).toBe(404);
      expect((await get("short")).status).toBe(400);
      expect((await get("bad token!!!!!!!!!!!!!!!")).status).toBe(400);
      await call(owner, "PATCH", `/monitor/${id}`, { active: false });
      const before = (await row(id)).lastPingAt!.getTime();
      await Bun.sleep(1100);
      expect((await get(token)).status).toBe(200);
      expect((await row(id)).lastPingAt!.getTime()).toBe(before);
    });

    test("resuming restarts the clock; the watch interval can't be changed; check-in timing can", async () => {
      const before = (await row(id)).heartbeatSince!.getTime();
      await Bun.sleep(20);
      const resumed = await json(
        await call(owner, "PATCH", `/monitor/${id}`, { active: true, interval: 3600 }),
      );
      expect(resumed.interval).toBe(60);
      expect((await row(id)).heartbeatSince!.getTime()).toBeGreaterThan(before);
      const updated = await json(
        await call(owner, "PATCH", `/monitor/${id}`, {
          config: { expectEvery: 86400, grace: 7200 },
        }),
      );
      expect(updated.config).toEqual({ expectEvery: 86400, grace: 7200 });
      expect((await call(owner, "PATCH", `/monitor/${id}`, { config: { grace: 5 } })).status).toBe(
        422,
      );
    });

    test("rotating the token kills the old address at once; only members can, and only on heartbeats", async () => {
      const rotated = await json(await call(owner, "POST", `/monitor/${id}/rotate-token`));
      const fresh = rotated.pingUrl.split("/").pop();
      expect(fresh).not.toBe(token);
      expect((await app.handle(new Request(`http://localhost/ping/${token}`))).status).toBe(404);
      expect((await app.handle(new Request(`http://localhost/ping/${fresh}`))).status).toBe(200);
      expect((await call(viewer, "POST", `/monitor/${id}/rotate-token`)).status).toBe(403);
      const plain = await json(await http());
      expect((await call(owner, "POST", `/monitor/${plain.id}/rotate-token`)).status).toBe(409);
      expect((await call(other, "POST", `/monitor/${id}/rotate-token`)).status).toBe(404);
    });
  });
});
