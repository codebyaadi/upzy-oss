"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { toast } from "@upzy/ui/components/sonner";
import { Spinner } from "@upzy/ui/components/spinner";
import { useState } from "react";

import { ViewOnlyNote } from "@/components/app/can";
import { ErrorNote, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const OPTIONS = [
  {
    name: "Gmail",
    when: "Quickest to start. About 500 emails a day; mail comes from your Gmail address.",
    env: `SMTP_URL=smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465\nMAIL_FROM="Upzy <you@gmail.com>"`,
    note: "Needs 2-step verification, then an App Password at myaccount.google.com/apppasswords (16 characters, no spaces). Use %40 for the @ in your address.",
  },
  {
    name: "Brevo or Resend",
    when: "Mail from your own domain, with a free tier.",
    env: `SMTP_URL=smtps://USERNAME:PASSWORD@smtp-relay.brevo.com:465\nMAIL_FROM="Upzy <alerts@your-domain.com>"`,
    note: "Add the provider's SPF and DKIM records at your DNS host so mail isn't marked as spam. Resend's SMTP host is smtp.resend.com (user: resend, password: your API key).",
  },
  {
    name: "Amazon SES",
    when: "Best if you already run on AWS.",
    env: `SMTP_URL=smtps://SMTP_USER:SMTP_PASSWORD@email-smtp.REGION.amazonaws.com:465\nMAIL_FROM="Upzy <alerts@your-domain.com>"`,
    note: "Verify the domain, request production access (the sandbox only sends to verified addresses), and URL-encode the user and password.",
  },
];

/** Checks that the server can send email, and says what to set when it can't. Admins only. */
export default function EmailSettingsPage() {
  const { can, user } = useWorkspace();
  const { run, isPending } = useAction();
  const status = useApi("email-status", () => unwrap(api.email.status.get()), {
    // Viewers and members get a 403: the page just explains that.
    shouldRetryOnError: false,
  });
  const [testId, setTestId] = useState<string | null>(null);
  const test = useApi(
    testId ? `email-test:${testId}` : null,
    () => unwrap(api.email.test({ id: testId! }).get()),
    {
      refreshInterval: (d) => (d && d.state !== "sending" ? 0 : 1_500),
      onSuccess: (d) => {
        if (d.state === "sent")
          toast.success("Test email sent", { description: `Check the inbox of ${user.email}.` });
        if (d.state === "failed") toast.error("The test email failed");
      },
    },
  );
  const s = status.data;
  const t = test.data;

  const sendTest = () =>
    run(
      "test",
      async () => {
        const r = (await unwrap(api.email.test.post())) as { id: string };
        setTestId(r.id);
      },
      { error: "Couldn't start the test" },
    );

  return (
    <>
      <PageHeader
        title="Email"
        description="Invitations, password resets and email alerts are sent through the SMTP server configured on your Upzy server."
      />
      {!can("admin") && <ViewOnlyNote what="the email settings" />}
      {can("admin") && <ErrorNote error={status.error} />}
      {can("admin") && !s && !status.error && <Skeleton className="h-40 w-full rounded-3xl" />}

      {can("admin") && s && (
        <div className="space-y-4">
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-xl font-bold tracking-tight">Delivery</h2>
                {s.configured ? (
                  <p className="text-muted-foreground mt-1 text-sm">
                    Sending through{" "}
                    <span className="text-foreground font-mono">
                      {s.host}:{s.port}
                    </span>
                    {s.secure ? " (TLS)" : ""}
                    {s.from ? (
                      <>
                        {" "}
                        as <span className="text-foreground font-mono">{s.from}</span>
                      </>
                    ) : null}
                    .
                  </p>
                ) : (
                  <p className="text-muted-foreground mt-1 text-sm">
                    No SMTP server is set, so no email is sent. Webhook, Slack and Discord alerts
                    still work.
                  </p>
                )}
              </div>
              <Badge variant={s.configured ? "default" : "outline"}>
                {s.configured ? "Configured" : "Not set up"}
              </Badge>
            </div>

            {s.configured && (
              <div className="mt-5 space-y-3">
                <Button loading={isPending("test") || t?.state === "sending"} onClick={sendTest}>
                  Send a test email to me
                </Button>
                {t?.state === "sending" && (
                  <p
                    role="status"
                    className="text-muted-foreground flex items-center gap-2 text-sm"
                  >
                    <Spinner aria-hidden /> Sending to {user.email}…
                  </p>
                )}
                {t?.state === "sent" && (
                  <p role="status" className="bg-accent/60 rounded-2xl px-4 py-3 text-sm">
                    Sent to <strong>{user.email}</strong>. If it doesn&rsquo;t arrive in a minute,
                    check spam: that usually means the sender&rsquo;s SPF/DKIM records are missing.
                  </p>
                )}
                {t?.state === "failed" && (
                  <p
                    role="alert"
                    className="bg-destructive/10 text-destructive rounded-2xl px-4 py-3 text-sm"
                  >
                    The server couldn&rsquo;t send it{t.error ? `: ${t.error}` : "."}
                  </p>
                )}
              </div>
            )}
          </Panel>

          <Panel>
            <h2 className="text-xl font-bold tracking-tight">
              {s.configured ? "Change the setup" : "Set it up"}
            </h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Email is configured on the server, not here: put these two lines in{" "}
              <code className="font-mono">/opt/upzy/deploy/.env</code>, then run{" "}
              <code className="font-mono">docker compose up -d api worker</code>. Choose one
              provider.
            </p>
            <div className="mt-4 space-y-3">
              {OPTIONS.map((o) => (
                <details key={o.name} className="rounded-2xl border px-4 py-3">
                  <summary className="cursor-pointer text-sm font-semibold">
                    {o.name} <span className="text-muted-foreground font-normal">: {o.when}</span>
                  </summary>
                  <pre className="bg-muted mt-3 overflow-x-auto rounded-xl p-3 font-mono text-xs">
                    {o.env}
                  </pre>
                  <p className="text-muted-foreground mt-2 text-xs">{o.note}</p>
                </details>
              ))}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
