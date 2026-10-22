import { describe, expect, test } from "bun:test";

import { EMAIL_QUEUE, emails } from "@upzy/auth/email";
import { deliver } from "@upzy/notify";

import { handleEmail, resendSender, withHtml } from "../src/roles/notifier";

describe("queued transactional email", () => {
  test("sends the queued message with its HTML version rendered from the template", async () => {
    const sent: any[] = [];
    await handleEmail(
      async (m) => void sent.push(m),
      emails.resetPassword({ to: "a@b.co", name: "Ada", url: "https://app/reset?token=t" }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "a@b.co", subject: "Reset your Upzy password" });
    expect(sent[0].text).toContain("https://app/reset?token=t");
    expect(sent[0].html).toContain("https://app/reset?token=t");
    expect(sent[0].html).toContain("Set a new password");
    // The template reference is queue plumbing, not part of the message.
    expect(sent[0].template).toBeUndefined();
  });

  test("a message without a template (the admin test email) goes out as plain text", async () => {
    const sent: any[] = [];
    await handleEmail(async (m) => void sent.push(m), {
      to: "a@b.co",
      subject: "Upzy test email",
      text: "hello",
    });
    expect(sent[0]).toEqual({ to: "a@b.co", subject: "Upzy test email", text: "hello" });
  });

  test("a template that can't render still sends the text, so a password reset is never lost", async () => {
    const sent: any[] = [];
    const quiet = console.error;
    console.error = () => {};
    try {
      await handleEmail(async (m) => void sent.push(m), {
        to: "a@b.co",
        subject: "s",
        text: "plain",
        template: { name: "nope" as never, props: {} },
      });
    } finally {
      console.error = quiet;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("plain");
    expect(sent[0].html).toBeUndefined();
  });

  test("without a mail provider it throws so the job is retried rather than silently dropped", async () => {
    await expect(
      handleEmail(undefined, emails.verifyEmail({ to: "a@b.co", name: "Ada", url: "u" })),
    ).rejects.toThrow(/not configured/);
  });

  test("invitations name the role with the right article", () => {
    const m = emails.invitation({
      to: "x@y.co",
      organization: "Acme",
      inviter: "Ada",
      role: "admin",
      url: "https://app/accept/1",
    });
    expect(m.subject).toBe("Ada invited you to Acme on Upzy");
    expect(m.text).toContain("as an admin");
    expect(m.text).toContain("https://app/accept/1");
    expect(
      emails.invitation({ to: "x", organization: "A", inviter: "B", role: "member", url: "u" })
        .text,
    ).toContain("as a member");
  });

  test("the queue name is stable", () => {
    expect(EMAIL_QUEUE).toBe("email");
  });
});

describe("email alert channels", () => {
  test("an incident alert keeps its plain text and gains the branded HTML", async () => {
    const sent: any[] = [];
    await deliver(
      { kind: "email", to: "ops@acme.test" },
      {
        event: "incident.opened",
        incident: {
          id: "1",
          title: "API is down",
          openedAt: "2026-10-20T10:00:00Z",
          resolvedAt: null,
        },
        monitor: { id: "m", name: "API", target: "https://api.acme.test" },
        url: "https://app/incidents/1",
      },
      { email: async (m) => void sent.push(await withHtml(m)) },
    );
    expect(sent[0].subject).toBe("[Down] API");
    expect(sent[0].text).toBe("🔴 API is down\nhttps://api.acme.test\nhttps://app/incidents/1");
    expect(sent[0].html).toContain("API is down");
    expect(sent[0].html).toContain("https://app/incidents/1");
    expect(sent[0].template).toBeUndefined();
  });
});

describe("Resend", () => {
  const okFetch = (calls: { url: string; init: RequestInit }[], status = 200) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, init: init! });
      return new Response(status < 300 ? '{"id":"1"}' : '{"message":"domain not verified"}', {
        status,
      });
    }) as never;

  test("posts the message to the Resend API with the key and sender", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const send = resendSender("re_key", "Upzy <alerts@example.com>", okFetch(calls));
    await send({
      to: "a@b.co",
      subject: "Hi",
      text: "plain",
      html: "<p>rich</p>",
      headers: { "List-Unsubscribe": "<https://u>" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: "Upzy <alerts@example.com>",
      to: ["a@b.co"],
      subject: "Hi",
      text: "plain",
      html: "<p>rich</p>",
      headers: { "List-Unsubscribe": "<https://u>" },
    });
  });

  test("leaves out html and headers when there are none", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await resendSender("k", "f@x.co", okFetch(calls))({ to: "a@b.co", subject: "s", text: "t" });
    expect(Object.keys(JSON.parse(calls[0]!.init.body as string)).sort()).toEqual([
      "from",
      "subject",
      "text",
      "to",
    ]);
  });

  test("a refusal throws with Resend's reason, so the job retries and the test email says why", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    await expect(
      resendSender("k", "f@x.co", okFetch(calls, 403))({ to: "a@b.co", subject: "s", text: "t" }),
    ).rejects.toThrow(/403.*domain not verified/);
  });
});
