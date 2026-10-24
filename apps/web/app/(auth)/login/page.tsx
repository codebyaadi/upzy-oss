"use client";

import { signIn } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { GithubButton } from "@/components/app/github-button";
import { SsoSignIn } from "@/components/app/sso-sign-in";
import { Field, PageTitle } from "@/components/app/ui";
import { safeNext } from "@/lib/next-path";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [busy, setBusy] = useState(false);

  // GitHub sign-in sends failures back here as ?error=<code>.
  const oauthError = params.get("error");
  useEffect(() => {
    if (!oauthError) return;
    toast.error(
      oauthError === "unable_to_create_user" || oauthError === "signup_disabled"
        ? "Sign-ups are by invitation only. Ask a team admin to invite you."
        : "Could not sign in with GitHub. Try again, or use your email.",
    );
  }, [oauthError]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { data, error } = await signIn.email({
      email: String(f.get("email")),
      password: String(f.get("password")),
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Could not sign in");
    // Someone with two-factor is sent on to enter their code (the auth client does that redirect itself).
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return;
    router.replace(next);
  }

  const nextQuery = params.get("next") ? { next } : undefined;

  return (
    <div className="space-y-5">
      <form onSubmit={onSubmit} className="space-y-5">
        <PageTitle>Sign in</PageTitle>
        <div>
          <h1 className="text-2xl font-extrabold tracking-tighter">Welcome back</h1>
          <p className="text-muted-foreground mt-1 text-sm">Sign in to your Upzy account.</p>
        </div>
        <GithubButton next={next} newUserNext={params.get("next") ? next : "/onboarding"} />
        <Field label="Email" htmlFor="email">
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <div className="-mt-2 text-right text-sm">
          <Link
            href="/forgot-password"
            className="text-muted-foreground hover:text-foreground underline underline-offset-4"
          >
            Forgot password?
          </Link>
        </div>
        <Button type="submit" className="w-full" size="lg" loading={busy}>
          Sign in
        </Button>
        <p className="text-muted-foreground text-center text-sm">
          New to Upzy?{" "}
          <Link
            href={{ pathname: "/sign-up", query: nextQuery }}
            className="text-foreground font-semibold underline underline-offset-4"
          >
            Create an account
          </Link>
        </p>
      </form>
      <SsoSignIn next={next} />
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
