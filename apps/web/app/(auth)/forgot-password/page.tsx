"use client";

import { requestPasswordReset } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useState } from "react";

import { Field, PageTitle } from "@/components/app/ui";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    setBusy(true);
    const { error } = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Could not send the email");
    setSent(true);
  }

  if (sent) {
    return (
      <div className="space-y-4" role="status">
        <h1 className="text-2xl font-extrabold tracking-tighter">Check your email</h1>
        <p className="text-muted-foreground text-sm">
          If an account exists for that address, we&rsquo;ve sent a link to reset the password. It
          expires in an hour.
        </p>
        <Link href="/login" className="text-sm font-semibold underline underline-offset-4">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageTitle>Reset your password</PageTitle>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tighter">Reset your password</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Enter your email and we&rsquo;ll send you a reset link.
        </p>
      </div>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Send reset link
      </Button>
      <p className="text-muted-foreground text-center text-sm">
        <Link href="/login" className="font-semibold underline underline-offset-4">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
