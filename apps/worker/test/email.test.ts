import { describe, expect, test } from "bun:test";

import { EMAIL_QUEUE, emails } from "@upzy/auth/email";

import { handleEmail } from "../src/roles/notifier";

describe("queued transactional email", () => {
  test("sends the queued message through the SMTP sender", async () => {
    const sent: unknown[] = [];
    await handleEmail(
      async (m) => void sent.push(m),
      emails.resetPassword({ to: "a@b.co", name: "Ada", url: "https://app/reset?token=t" }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "a@b.co", subject: "Reset your Upzy password" });
  });

  test("without SMTP it throws so the job is retried rather than silently dropped", async () => {
    await expect(
      handleEmail(undefined, emails.verifyEmail({ to: "a@b.co", name: "Ada", url: "u" })),
    ).rejects.toThrow("SMTP_URL");
  });

  test("the queue name is shared with the producer", () => {
    expect(EMAIL_QUEUE).toBe("email");
  });

  test("invitation text names the organisation, role and link, with correct grammar", () => {
    const m = emails.invitation({
      to: "x@y.z",
      organization: "Acme",
      inviter: "Ada",
      role: "admin",
      url: "https://app/accept-invitation/1",
    });
    expect(m.subject).toBe("Ada invited you to Acme on Upzy");
    expect(m.text).toContain("as an admin");
    expect(m.text).toContain("https://app/accept-invitation/1");
    expect(
      emails.invitation({ to: "x", organization: "A", inviter: "B", role: "member", url: "u" })
        .text,
    ).toContain("as a member");
  });
});
