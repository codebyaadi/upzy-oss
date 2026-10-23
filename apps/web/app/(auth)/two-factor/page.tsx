"use client";

import { twoFactor } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { Field, PageTitle } from "@/components/app/ui";
import { safeNext } from "@/lib/next-path";

function TwoFactorForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const code = String(f.get("code")).replace(/\s/g, "");
    setBusy(true);
    const { error } = backup
      ? await twoFactor.verifyBackupCode({ code })
      : await twoFactor.verifyTotp({ code, trustDevice: f.get("trust") === "on" });
    setBusy(false);
    if (error) return toast.error(error.message ?? "That code isn't right");
    router.replace(next);
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageTitle>Two-factor sign-in</PageTitle>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tighter">One more step</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {backup
            ? "Enter one of your backup codes. Each works once."
            : "Enter the 6-digit code from your authenticator app."}
        </p>
      </div>
      <Field label={backup ? "Backup code" : "6-digit code"} htmlFor="code">
        <Input
          id="code"
          name="code"
          key={String(backup)}
          inputMode={backup ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoFocus
          required
        />
      </Field>
      {!backup && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="trust" className="size-4" />
          Don&apos;t ask again on this device for 30 days
        </label>
      )}
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Verify
      </Button>
      <p className="text-muted-foreground text-center text-sm">
        <button
          type="button"
          className="text-foreground font-semibold underline underline-offset-4"
          onClick={() => setBackup((b) => !b)}
        >
          {backup ? "Use my authenticator app" : "Use a backup code"}
        </button>
      </p>
    </form>
  );
}

export default function TwoFactorPage() {
  return (
    <Suspense>
      <TwoFactorForm />
    </Suspense>
  );
}
