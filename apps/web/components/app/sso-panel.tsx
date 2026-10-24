"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { useState } from "react";

import { useConfirm } from "@/components/app/confirm";
import { ErrorNote, Field, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

function Copy({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-xs font-semibold">{label}</div>
      <code className="bg-muted block rounded-md px-2 py-1.5 text-xs break-all select-all">
        {value}
      </code>
    </div>
  );
}

/** Single sign-on for the organization: connect an OpenID Connect provider and prove the email domain with DNS. */
export function SsoPanel({ orgId }: { orgId: string }) {
  const sso = useApi(`sso:${orgId}`, () => unwrap(api.sso.get()));
  const { run, isPending } = useAction();
  const confirm = useConfirm();
  const [form, setForm] = useState({ issuer: "", domain: "", clientId: "", clientSecret: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const provider = sso.data?.provider ?? null;
  const verification = sso.data?.verification ?? null;

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    void run(
      "connect",
      async () => {
        await unwrap(api.sso.post(form));
        setForm((f) => ({ ...f, clientSecret: "" }));
        await sso.mutate();
      },
      { success: "Connected. Add the DNS record to finish.", error: "Couldn't connect" },
    );
  };

  const verify = () =>
    run(
      "verify",
      async () => {
        await unwrap(api.sso.verify.post());
        await sso.mutate();
      },
      { success: "Domain verified. Single sign-on is on.", error: "Couldn't verify the domain" },
    );

  const remove = async () => {
    if (
      !(await confirm({
        title: "Remove single sign-on?",
        description:
          "People who joined through it keep their account and access, but can no longer sign in with it.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    await run(
      "remove",
      async () => {
        await unwrap(api.sso.delete());
        await sso.mutate();
      },
      { success: "Single sign-on removed", error: "Couldn't remove it" },
    );
  };

  return (
    <Panel>
      <h2 className="text-xl font-bold tracking-tight">Single sign-on</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Let your team sign in with your identity provider (Okta, Microsoft Entra, Google Workspace,
        Keycloak, any OpenID Connect provider). Anyone with an email on your domain is added as a
        member the first time they sign in.
      </p>
      <ErrorNote error={sso.error} />

      {provider ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <Copy label="Provider" value={provider.issuer} />
            <Copy label="Email domain" value={provider.domain} />
          </div>
          {provider.domainVerified ? (
            <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
              Domain verified. People at {provider.domain} can sign in from the login page with
              &ldquo;Sign in with single sign-on&rdquo;.
            </p>
          ) : (
            <div className="space-y-3 rounded-lg border p-3 text-sm">
              <p className="font-semibold">Prove you own {provider.domain}</p>
              <p className="text-muted-foreground text-xs">
                Add this DNS record, then verify. Nobody can sign in through the provider until you
                do. DNS changes can take a few minutes.
              </p>
              {verification && (
                <div className="grid gap-2">
                  <Copy label="Type" value={verification.type} />
                  <Copy label="Name" value={verification.name} />
                  <Copy label="Value" value={verification.value} />
                </div>
              )}
              <Button size="sm" onClick={() => void verify()} loading={isPending("verify")}>
                Verify domain
              </Button>
            </div>
          )}
          <Copy label="Redirect URI to register at your provider" value={provider.redirectUri} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void remove()}
            loading={isPending("remove")}
          >
            Remove single sign-on
          </Button>
        </div>
      ) : (
        <form onSubmit={connect} className="mt-4 space-y-4">
          <p className="text-muted-foreground text-xs">
            First create an application at your provider (type: web, grant: authorization code) and
            give it the redirect URI shown after you connect. Upzy needs its client ID and secret.
          </p>
          <Field label="Issuer URL" htmlFor="sso-issuer">
            <Input
              id="sso-issuer"
              type="url"
              required
              placeholder="https://your-company.okta.com"
              value={form.issuer}
              onChange={set("issuer")}
            />
          </Field>
          <Field label="Email domain" htmlFor="sso-domain">
            <Input
              id="sso-domain"
              required
              placeholder="your-company.com"
              value={form.domain}
              onChange={set("domain")}
            />
          </Field>
          <Field label="Client ID" htmlFor="sso-client-id">
            <Input id="sso-client-id" required value={form.clientId} onChange={set("clientId")} />
          </Field>
          <Field label="Client secret" htmlFor="sso-client-secret">
            <Input
              id="sso-client-secret"
              type="password"
              required
              autoComplete="off"
              value={form.clientSecret}
              onChange={set("clientSecret")}
            />
          </Field>
          <Button type="submit" loading={isPending("connect")}>
            Connect
          </Button>
        </form>
      )}
    </Panel>
  );
}
