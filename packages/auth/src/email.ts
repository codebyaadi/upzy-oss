import type { Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";

/** Queue the worker's notifier drains and sends over SMTP. */
export const EMAIL_QUEUE = "email";

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export type SendEmail = (email: Email) => Promise<void>;

/** Hands the message to the worker instead of sending in the request path: SMTP slowness never blocks auth. */
export const queueEmail =
  (db: Db): SendEmail =>
  async (email) => {
    await enqueue(db, EMAIL_QUEUE, email, { maxAttempts: 5 });
  };

export const emails = {
  invitation: (p: {
    to: string;
    organization: string;
    inviter: string;
    role: string;
    url: string;
  }): Email => ({
    to: p.to,
    subject: `${p.inviter} invited you to ${p.organization} on Upzy`,
    text: `${p.inviter} invited you to join ${p.organization} on Upzy as ${p.role === "admin" ? "an" : "a"} ${p.role}.\n\nAccept the invitation:\n${p.url}\n\nIf you weren't expecting this, you can ignore this email.`,
  }),
  resetPassword: (p: { to: string; name: string; url: string }): Email => ({
    to: p.to,
    subject: "Reset your Upzy password",
    text: `Hi ${p.name},\n\nSomeone asked to reset the password for your Upzy account. Set a new one here (the link expires in 1 hour):\n${p.url}\n\nIf this wasn't you, ignore this email: your password stays the same.`,
  }),
  verifyEmail: (p: { to: string; name: string; url: string }): Email => ({
    to: p.to,
    subject: "Confirm your email for Upzy",
    text: `Hi ${p.name},\n\nConfirm your email address to finish setting up your Upzy account:\n${p.url}`,
  }),
  statusConfirm: (p: { to: string; page: string; url: string }): Email => ({
    to: p.to,
    subject: `Confirm updates from ${p.page}`,
    text: `Someone (hopefully you) asked to get an email when ${p.page} reports an incident.\n\nConfirm here:\n${p.url}\n\nIf this wasn't you, ignore this email and you won't hear from us again.`,
  }),
  statusNotice: (p: {
    to: string;
    page: string;
    headline: string;
    stage?: string;
    message?: string;
    pageUrl: string;
    unsubscribeUrl: string;
  }): Email => ({
    to: p.to,
    subject: `[${p.page}] ${p.headline}`,
    text: `${p.headline}\n${p.stage && p.message ? `\n${p.stage}: ${p.message}\n` : ""}\nLive status: ${p.pageUrl}\n\n--\nYou get this because you subscribed to updates from ${p.page}.\nUnsubscribe: ${p.unsubscribeUrl}`,
    headers: { "List-Unsubscribe": `<${p.unsubscribeUrl}>` },
  }),
};
