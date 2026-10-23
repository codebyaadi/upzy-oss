"use client";

import { Switch } from "@upzy/ui/components/switch";

import { ViewOnlyNote } from "@/components/app/can";
import { TwoFactorSetup } from "@/components/app/two-factor-setup";
import { ErrorNote, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

/** How you sign in, and the organization's rule that everyone must use two-factor. */
export default function SecurityPage() {
  const { can, orgId } = useWorkspace();
  const { run, isPending } = useAction();
  const policy = useApi(can("admin") ? `security-policy:${orgId}` : null, () =>
    unwrap(api.security.policy.get()),
  );
  const status = useApi("security", () => unwrap(api.security.get()));

  const setRequired = (on: boolean) =>
    run(
      "policy",
      async () => {
        await unwrap(api.security.policy.put({ requireTwoFactor: on }));
        await Promise.all([policy.mutate(), status.mutate()]);
      },
      {
        success: on ? "Two-factor is now required" : "Two-factor is no longer required",
        error: "Couldn't change the rule",
      },
    );

  const missing = policy.data?.withoutTwoFactor ?? [];

  return (
    <>
      <PageHeader
        title="Security"
        description="Protect your sign-in with an authenticator app, and decide whether your team has to."
      />
      <ErrorNote error={policy.error ?? status.error} />
      <div className="max-w-2xl space-y-4">
        <Panel>
          <h2 className="text-xl font-bold tracking-tight">Two-factor authentication</h2>
          <div className="mt-4">
            <TwoFactorSetup onChange={() => void Promise.all([policy.mutate(), status.mutate()])} />
          </div>
        </Panel>

        {can("admin") ? (
          <Panel>
            <h2 className="text-xl font-bold tracking-tight">Require it for everyone</h2>
            <label className="mt-4 flex items-start justify-between gap-4 text-sm">
              <span>
                <span className="font-semibold">Members must use two-factor</span>
                <span className="text-muted-foreground block text-xs">
                  People without it can&apos;t use this organization until they set it up. You need
                  it on your own account first.
                </span>
              </span>
              <Switch
                aria-label="Require two-factor for everyone"
                checked={policy.data?.requireTwoFactor ?? false}
                disabled={!policy.data || isPending("policy")}
                onCheckedChange={(on) => void setRequired(on)}
              />
            </label>
            {missing.length > 0 && (
              <div className="mt-4 text-sm">
                <p className="font-semibold">
                  {missing.length} {missing.length === 1 ? "person has" : "people have"} not set it
                  up
                </p>
                <ul className="text-muted-foreground mt-1 list-disc space-y-0.5 pl-5">
                  {missing.map((m) => (
                    <li key={m.email}>
                      {m.name} <span className="text-xs">({m.email})</span>
                    </li>
                  ))}
                </ul>
                {policy.data?.requireTwoFactor && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    They are asked to set it up the next time they open Upzy.
                  </p>
                )}
              </div>
            )}
          </Panel>
        ) : (
          status.data?.organizationRequires && (
            <ViewOnlyNote what="the organization's two-factor rule" />
          )
        )}
      </div>
    </>
  );
}
