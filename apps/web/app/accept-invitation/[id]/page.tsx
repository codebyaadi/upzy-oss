"use client";

import { organization, useSession } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

import { PageTitle } from "@/components/app/ui";
import { Logo } from "@/components/logo";

type State = { kind: "idle" } | { kind: "working" } | { kind: "error"; message: string };

/** Lives outside the (app) group: the person has no organization yet, so the dashboard gate would bounce them. */
export default function AcceptInvitationPage() {
  const { id } = useParams<{ id: string }>();
  const { data: session, isPending } = useSession();
  const [state, setState] = useState<State>({ kind: "idle" });
  const next = `/accept-invitation/${id}`;

  // Not signed in yet: go sign in (or sign up) and come straight back here.
  useEffect(() => {
    if (!isPending && !session) {
      window.location.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [isPending, session, next]);

  async function accept() {
    setState({ kind: "working" });
    const res = await organization.acceptInvitation({ invitationId: id });
    if (res.error || !res.data) {
      const message = res.error?.message ?? "This invitation could not be accepted.";
      toast.error("Couldn't join the team", { description: message });
      return setState({ kind: "error", message });
    }
    await organization.setActive({ organizationId: res.data.invitation.organizationId });
    toast.success("You joined the team");
    // Full navigation so the dashboard boots with the new active organization in the session.
    window.location.assign("/monitors");
  }

  return (
    <div className="ambient grid min-h-svh place-items-center px-4 py-12">
      <div className="w-full max-w-md">
        <Link href="/" aria-label="Upzy home" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <div className="bg-card/70 rounded-3xl border p-8 shadow-[var(--shadow-panel)] backdrop-blur-xl">
          <PageTitle>Join the team</PageTitle>
          <h1 className="text-2xl font-extrabold tracking-tighter">Join the team</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            {session
              ? `You're signed in as ${session.user.email}. Accept to join the organization you were invited to.`
              : "Checking your session…"}
          </p>
          {state.kind === "error" && (
            <p
              role="alert"
              className="bg-destructive/10 text-destructive mt-4 rounded-2xl px-4 py-3 text-sm"
            >
              {state.message} Make sure you&rsquo;re signed in with the email address that was
              invited.
            </p>
          )}
          <Button
            className="mt-6 w-full"
            size="lg"
            disabled={!session}
            loading={state.kind === "working"}
            onClick={accept}
          >
            Accept invitation
          </Button>
        </div>
      </div>
    </div>
  );
}
