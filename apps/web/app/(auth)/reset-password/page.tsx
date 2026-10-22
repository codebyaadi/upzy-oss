"use client";

import { resetPassword } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Field, PageTitle } from "@/components/app/ui";

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token");
  const [busy, setBusy] = useState(false);

  if (!token || params.get("error")) {
    return (
      <div className="space-y-4" role="alert">
        <PageTitle>Reset link invalid</PageTitle>
        <h1 className="text-2xl font-extrabold tracking-tighter">This link isn&rsquo;t valid</h1>
        <p className="text-muted-foreground text-sm">
          The reset link is invalid or has expired. Request a new one.
        </p>
        <Link
          href="/forgot-password"
          className="text-sm font-semibold underline underline-offset-4"
        >
          Send a new link
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password !== String(f.get("confirm"))) return toast.error("The passwords don't match.");
    setBusy(true);
    const { error } = await resetPassword({ newPassword: password, token: token! });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Could not reset the password");
    toast.success("Password updated. Sign in with your new password.");
    router.replace("/login");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageTitle>Choose a new password</PageTitle>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tighter">Choose a new password</h1>
      </div>
      <Field label="New password" htmlFor="password" hint="At least 8 characters.">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>
      <Field label="Confirm password" htmlFor="confirm">
        <Input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Reset password
      </Button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
