"use client";

import { deleteUser, useActiveOrganization } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { Switch } from "@upzy/ui/components/switch";
import { useState } from "react";

import { ErrorNote, Field, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

/** Your own settings: which emails you get, and deleting the organization or your account. */
export default function AccountPage() {
  const { user, can } = useWorkspace();
  const { data: org } = useActiveOrganization();
  const { run, isPending } = useAction();
  const account = useApi("account", () => unwrap(api.account.get()));
  const [orgConfirm, setOrgConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [accountConfirm, setAccountConfirm] = useState("");

  const blocked = account.data?.blockedBy ?? [];

  async function toggleEmails(on: boolean) {
    await run(
      "emails",
      async () => {
        await unwrap(api.account.patch({ lifecycleEmails: on }));
        await account.mutate();
      },
      { success: on ? "You'll get product emails" : "Product emails are off" },
    );
  }

  async function removeOrganization() {
    const done = await run(
      "org",
      async () => {
        const { error } = await api.organization.delete({ confirm: orgConfirm });
        if (error) {
          const v = error.value as { message?: string } | undefined;
          throw new Error(v?.message ?? "Couldn't delete the organization");
        }
        return true;
      },
      { success: "Organization deleted", error: "Couldn't delete the organization" },
    );
    // The session still points at the deleted organization: reload so the app picks another or asks for a new one.
    if (done) window.location.assign("/");
  }

  async function removeAccount() {
    const done = await run(
      "account",
      async () => {
        const { error } = await deleteUser(password ? { password } : {});
        if (error) throw new Error(error.message ?? "Couldn't delete the account");
        return true;
      },
      { success: "Account deleted", error: "Couldn't delete the account" },
    );
    if (done) window.location.assign("/login");
  }

  return (
    <>
      <PageHeader title="Account" description={`Signed in as ${user.email}.`} />
      <ErrorNote error={account.error} />

      <div className="max-w-2xl space-y-4">
        <Panel>
          <h2 className="text-xl font-bold tracking-tight">Product emails</h2>
          <label className="mt-4 flex items-start justify-between gap-4 text-sm">
            <span>
              <span className="font-semibold">Welcome, tips and trial reminders</span>
              <span className="text-muted-foreground block text-xs">
                A welcome, a nudge to fix your first finding, and a heads-up before a trial ends.
                Alerts and account emails (password resets, invitations) always arrive.
              </span>
            </span>
            <Switch
              checked={account.data?.lifecycleEmails ?? true}
              disabled={!account.data || isPending("emails")}
              onCheckedChange={toggleEmails}
              aria-label="Product emails"
            />
          </label>
        </Panel>

        {can("owner") && org && (
          <Panel className="border-destructive/40 border">
            <h2 className="text-xl font-bold tracking-tight">Delete this organization</h2>
            <p className="text-muted-foreground mt-2 text-sm">
              Deletes <strong>{org.name}</strong> for good: its workspaces, monitors, incident
              history, assets, findings, status pages, alert channels and team. A paid subscription
              is cancelled first. Everyone in it is emailed. This can&apos;t be undone.
            </p>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void removeOrganization();
              }}
            >
              <Field label={`Type “${org.name}” to confirm`} htmlFor="org-confirm">
                <Input
                  id="org-confirm"
                  value={orgConfirm}
                  autoComplete="off"
                  onChange={(e) => setOrgConfirm(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="destructive"
                loading={isPending("org")}
                disabled={orgConfirm.trim() !== org.name}
              >
                Delete organization
              </Button>
            </form>
          </Panel>
        )}

        <Panel className="border-destructive/40 border">
          <h2 className="text-xl font-bold tracking-tight">Delete my account</h2>
          <p className="text-muted-foreground mt-2 text-sm">
            Deletes your sign-in and personal data. Organizations where you are the only person are
            deleted with it; in organizations with other people you are simply removed. This
            can&apos;t be undone.
          </p>
          {blocked.length > 0 ? (
            <p role="alert" className="bg-accent/60 mt-4 rounded-2xl px-4 py-3 text-sm">
              You are the only owner of {blocked.map((o) => o.name).join(", ")}, and other people
              belong to it. Make someone else an owner on the Team page, or remove them, then come
              back.
            </p>
          ) : (
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void removeAccount();
              }}
            >
              <Field
                label="Password"
                htmlFor="acct-password"
                hint="Signed in with GitHub? Leave this empty: you must have signed in within the last day."
              >
                <Input
                  id="acct-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Field label={`Type “${user.email}” to confirm`} htmlFor="acct-confirm">
                <Input
                  id="acct-confirm"
                  value={accountConfirm}
                  autoComplete="off"
                  onChange={(e) => setAccountConfirm(e.target.value)}
                />
              </Field>
              <Button
                type="submit"
                variant="destructive"
                loading={isPending("account")}
                disabled={accountConfirm.trim() !== user.email}
              >
                Delete my account
              </Button>
            </form>
          )}
        </Panel>
      </div>
    </>
  );
}
