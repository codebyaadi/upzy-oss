import type { Db } from "@upzy/db";
import { enqueue } from "@upzy/queue";
import { compose, type TemplateName, type TemplateProps } from "@upzy/transactional/templates";

/** Queue the worker's notifier drains and sends. */
export const EMAIL_QUEUE = "email";

export interface Email {
  to: string;
  subject: string;
  text: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
  /** Which @upzy/transactional template this is. The worker renders its HTML just before sending; `text` is the fallback. */
  template?: { name: TemplateName; props: unknown };
}

export type SendEmail = (email: Email) => Promise<void>;

/** Hands the message to the worker instead of sending in the request path: a slow mail provider never blocks auth. */
export const queueEmail =
  (db: Db): SendEmail =>
  async (email) => {
    await enqueue(db, EMAIL_QUEUE, email, { maxAttempts: 5 });
  };

/** Builds a message from a template (see packages/transactional). The wording and design live there, not here. */
const build =
  <N extends TemplateName>(name: N) =>
  (p: { to: string } & TemplateProps[N]): Email => {
    const { to, ...props } = p;
    return compose(name, to, props as unknown as TemplateProps[N]);
  };

export const emails = {
  invitation: build("invitation"),
  resetPassword: build("resetPassword"),
  verifyEmail: build("verifyEmail"),
  statusConfirm: build("statusConfirm"),
  statusNotice: build("statusNotice"),
  welcome: build("welcome"),
  fixNudge: build("fixNudge"),
  trialEnding: build("trialEnding"),
  accountDeleted: build("accountDeleted"),
  organizationDeleted: build("organizationDeleted"),
};
