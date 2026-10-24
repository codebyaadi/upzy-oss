"use client";

import { signIn } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

/**
 * "Sign in with single sign-on": the email's domain decides which organization's provider to use. Shown to everyone,
 * since a person can't be known before they type their address.
 */
export function SsoSignIn({ next }: { next: string }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("sso-email"));
    setBusy(true);
    const { error } = await signIn.sso({
      email,
      callbackURL: `${window.location.origin}${next}`,
      errorCallbackURL: `${window.location.origin}/login`,
    });
    // On success the browser is already on its way to the provider.
    if (error) {
      setBusy(false);
      toast.error(
        error.status === 404 || error.status === 400
          ? "Single sign-on isn't set up for that email's domain. Ask an admin of your team."
          : (error.message ?? "Could not start single sign-on"),
      );
    }
  }

  if (!open)
    return (
      <p className="text-center text-sm">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="text-muted-foreground hover:text-foreground underline underline-offset-4"
        >
          Sign in with single sign-on
        </button>
      </p>
    );

  return (
    <form onSubmit={go} className="flex gap-2">
      <Input
        name="sso-email"
        type="email"
        placeholder="you@your-company.com"
        autoComplete="email"
        aria-label="Work email"
        required
        autoFocus
      />
      <Button type="submit" loading={busy}>
        Continue
      </Button>
    </form>
  );
}
