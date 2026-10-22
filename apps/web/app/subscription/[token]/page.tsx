"use client";

import { Button } from "@upzy/ui/components/button";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { Logo } from "@/components/logo";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap } from "@/lib/use-api";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "ready"; pageTitle: string; confirmed: boolean }
  | { kind: "unsubscribed"; pageTitle: string };

/**
 * Where the links in subscriber emails land. Opening the link only shows the state: confirming and unsubscribing
 * are buttons, so a mail scanner that fetches every link can't confirm or cancel anyone.
 */
export default function SubscriptionPage() {
  const { token } = useParams<{ token: string }>();
  const { run, isPending } = useAction();
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    unwrap(api.public.subscription({ token }).get())
      .then((r) => setState({ kind: "ready", ...r }))
      .catch(() => setState({ kind: "missing" }));
  }, [token]);

  const confirm = () =>
    run(
      "confirm",
      async () => {
        const r = await unwrap(api.public.subscription({ token }).confirm.post());
        setState({ kind: "ready", pageTitle: r.pageTitle, confirmed: true });
      },
      { success: "You're subscribed", error: "Couldn't confirm" },
    );
  const unsubscribe = () =>
    run(
      "unsub",
      async () => {
        const r = await unwrap(api.public.subscription({ token }).unsubscribe.post());
        setState({ kind: "unsubscribed", pageTitle: r.pageTitle });
      },
      { success: "You're unsubscribed", error: "Couldn't unsubscribe" },
    );

  return (
    <div className="ambient grid min-h-svh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" aria-label="Upzy home" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <div className="bg-card/70 rounded-3xl border p-8 shadow-[var(--shadow-panel)] backdrop-blur-xl">
          {state.kind === "loading" && <p className="text-muted-foreground">Loading…</p>}
          {state.kind === "missing" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight">Link not found</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                This subscription link isn&apos;t valid any more. If you already unsubscribed,
                you&apos;re done.
              </p>
            </>
          )}
          {state.kind === "unsubscribed" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight">You&apos;re unsubscribed</h1>
              <p className="text-muted-foreground mt-2 text-sm">
                You won&apos;t get any more email from {state.pageTitle}.
              </p>
            </>
          )}
          {state.kind === "ready" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight">
                {state.confirmed ? "You're subscribed" : "Confirm your subscription"}
              </h1>
              <p className="text-muted-foreground mt-2 text-sm">
                {state.confirmed
                  ? `You'll get an email when ${state.pageTitle} reports an incident, posts an update or recovers.`
                  : `Get an email when ${state.pageTitle} reports an incident, posts an update or recovers.`}
              </p>
              <div className="mt-6 flex flex-wrap gap-2">
                {!state.confirmed && (
                  <Button loading={isPending("confirm")} onClick={confirm}>
                    Confirm subscription
                  </Button>
                )}
                <Button
                  variant={state.confirmed ? "default" : "ghost"}
                  loading={isPending("unsub")}
                  onClick={unsubscribe}
                >
                  Unsubscribe
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
