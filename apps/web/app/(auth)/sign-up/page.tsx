"use client";

import { signUp } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { GithubButton } from "@/components/app/github-button";
import { Field, PageTitle } from "@/components/app/ui";
import { safeNext } from "@/lib/next-path";

function SignUpForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Invited people arrive with ?next=/accept-invitation/<id> and skip creating their own organization.
  const next = safeNext(params.get("next"), "/onboarding");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await signUp.email({
      name: String(f.get("name")),
      email: String(f.get("email")),
      password: String(f.get("password")),
      callbackURL: `${window.location.origin}/monitors`,
    });
    setBusy(false);
    if (error) return toast.error(error.message ?? "Could not create the account");
    toast.success("Account created", {
      description: "Check your inbox to confirm your email address.",
    });
    router.replace(next);
  }

  const nextQuery = params.get("next") ? { next } : undefined;

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageTitle>Create account</PageTitle>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tighter">Create your account</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Start monitoring in a couple of minutes.
        </p>
      </div>
      <GithubButton next={next} newUserNext={next} />
      <Field label="Name" htmlFor="name">
        <Input id="name" name="name" autoComplete="name" required />
      </Field>
      <Field label="Email" htmlFor="email">
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" hint="At least 8 characters.">
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </Field>
      <p className="text-muted-foreground text-xs leading-relaxed">
        By creating an account you agree to the{" "}
        <Link href="/terms" className="text-foreground underline underline-offset-4">
          Terms
        </Link>
        , the{" "}
        <Link href="/privacy" className="text-foreground underline underline-offset-4">
          Privacy Policy
        </Link>{" "}
        and the{" "}
        <Link href="/acceptable-use" className="text-foreground underline underline-offset-4">
          Acceptable Use policy
        </Link>
        , including that you may only add sites you&apos;re allowed to scan.
      </p>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Create account
      </Button>
      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{" "}
        <Link
          href={{ pathname: "/login", query: nextQuery }}
          className="text-foreground font-semibold underline underline-offset-4"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}

export default function SignUpPage() {
  return (
    <Suspense>
      <SignUpForm />
    </Suspense>
  );
}
