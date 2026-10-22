import { render } from "@react-email/components";
import type { ComponentType } from "react";

import AccountDeleted from "./emails/account-deleted";
import FixNudge from "./emails/fix-nudge";
import Invitation from "./emails/invitation";
import OrganizationDeleted from "./emails/organization-deleted";
import ResetPassword from "./emails/reset-password";
import StatusConfirm from "./emails/status-confirm";
import StatusNotice from "./emails/status-notice";
import TrialEnding from "./emails/trial-ending";
import VerifyEmail from "./emails/verify-email";
import Welcome from "./emails/welcome";
import type { TemplateName, TemplateProps } from "./templates";

export * from "./templates";

const components: { [N in TemplateName]: ComponentType<TemplateProps[N]> } = {
  invitation: Invitation,
  resetPassword: ResetPassword,
  verifyEmail: VerifyEmail,
  statusConfirm: StatusConfirm,
  statusNotice: StatusNotice,
  welcome: Welcome,
  fixNudge: FixNudge,
  trialEnding: TrialEnding,
  accountDeleted: AccountDeleted,
  organizationDeleted: OrganizationDeleted,
};

/** The HTML for a template. Props are the ones the template was composed with (they survive the queue as JSON). */
export async function renderHtml(name: TemplateName, props: unknown): Promise<string> {
  const Component = components[name] as ComponentType<Record<string, unknown>> | undefined;
  if (!Component) throw new Error(`Unknown email template "${name}"`);
  return render(<Component {...(props as Record<string, unknown>)} />);
}
