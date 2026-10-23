"use client";

import { twoFactor, useSession } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

import { ErrorNote, Field } from "@/components/app/ui";
import { useAction } from "@/lib/use-action";

type Step =
  | { kind: "idle" }
  | { kind: "confirm"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[] };

const secretOf = (uri: string) => new URL(uri).searchParams.get("secret") ?? "";
const groups = (s: string) => s.match(/.{1,4}/g)?.join(" ") ?? s;

/**
 * Set up, check and turn off two-factor sign-in with an authenticator app. Used on the Security page, and on its
 * own when an organization requires two-factor and this person hasn't set it up yet.
 */
export function TwoFactorSetup({ onChange }: { onChange?: () => void }) {
  const { data: session, refetch } = useSession();
  const enabled = Boolean(
    (session?.user as { twoFactorEnabled?: boolean } | undefined)?.twoFactorEnabled,
  );
  const { run, isPending } = useAction();
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const done = async () => {
    await refetch();
    onChange?.();
  };

  const start = () =>
    run(
      "start",
      async () => {
        const { data, error } = await twoFactor.enable({ password: password || undefined });
        if (error || !data || !("totpURI" in data))
          throw new Error(error?.message ?? "Couldn't start the setup");
        setStep({ kind: "confirm", uri: data.totpURI, codes: data.backupCodes });
        setPassword("");
        setError(null);
      },
      { error: "Couldn't start the setup" },
    );

  const confirm = () =>
    run(
      "confirm",
      async () => {
        const { error } = await twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
        if (error) throw new Error(error.message ?? "That code isn't right");
        setCode("");
        setStep((s) => ({ kind: "codes", codes: s.kind === "confirm" ? s.codes : [] }));
        await done();
      },
      { success: "Two-factor authentication is on", error: "That code isn't right" },
    );

  const turnOff = () =>
    run(
      "off",
      async () => {
        const { error } = await twoFactor.disable({ password: password || undefined });
        if (error) throw new Error(error.message ?? "Couldn't turn it off");
        setPassword("");
        setStep({ kind: "idle" });
        await done();
      },
      { success: "Two-factor authentication is off", error: "Couldn't turn it off" },
    );

  const newCodes = () =>
    run(
      "codes",
      async () => {
        const { data, error } = await twoFactor.generateBackupCodes({
          password: password || undefined,
        });
        if (error || !data) throw new Error(error?.message ?? "Couldn't make new codes");
        setPassword("");
        setStep({ kind: "codes", codes: data.backupCodes });
      },
      {
        success: "New backup codes made. The old ones no longer work.",
        error: "Couldn't make new codes",
      },
    );

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
    } catch {
      toast.error("Couldn't copy. Select the codes and copy them by hand.");
    }
  };

  const passwordField = (hint: string) => (
    <Field label="Password" htmlFor="tf-password" hint={hint}>
      <Input
        id="tf-password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
    </Field>
  );

  if (step.kind === "confirm")
    return (
      <div className="space-y-5">
        <ErrorNote error={error} />
        <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-sm">
          <li>
            Open an authenticator app (1Password, Authy, Google Authenticator, Microsoft
            Authenticator).
          </li>
          <li>Scan this code, or type the key by hand.</li>
          <li>Enter the 6-digit code it shows.</li>
        </ol>
        <div className="flex flex-wrap items-center gap-5">
          <div className="rounded-2xl bg-white p-3">
            <QRCodeSVG
              value={step.uri}
              size={160}
              role="img"
              aria-label="QR code for your authenticator app"
            />
          </div>
          <div className="min-w-0 text-sm">
            <p className="text-muted-foreground text-xs">Key, if you can&apos;t scan</p>
            <p className="font-mono font-semibold break-all select-all">
              {groups(secretOf(step.uri))}
            </p>
          </div>
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <Field label="6-digit code" htmlFor="tf-code">
            <Input
              id="tf-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" loading={isPending("confirm")}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setStep({ kind: "idle" })}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    );

  if (step.kind === "codes")
    return (
      <div className="space-y-4">
        <p className="text-sm leading-relaxed">
          <strong>Save these backup codes.</strong> Each works once if you lose your phone. They are
          shown only now.
        </p>
        <ul className="bg-muted grid grid-cols-2 gap-x-6 gap-y-1 rounded-2xl p-4 font-mono text-sm select-all">
          {step.codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => void copy(step.codes.join("\n"))}>
            Copy
          </Button>
          <Button onClick={() => setStep({ kind: "idle" })}>I&apos;ve saved them</Button>
        </div>
      </div>
    );

  if (!enabled)
    return (
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <p className="text-muted-foreground text-sm leading-relaxed">
          Sign-in will also ask for a 6-digit code from an app on your phone, so a stolen password
          isn&apos;t enough.
        </p>
        {passwordField("Leave empty if you sign in with GitHub and have no password.")}
        <Button type="submit" loading={isPending("start")}>
          Set up two-factor
        </Button>
      </form>
    );

  return (
    <div className="space-y-4">
      <p role="status" className="bg-accent/60 rounded-2xl px-4 py-3 text-sm">
        Two-factor authentication is <strong>on</strong> for your account.
      </p>
      {passwordField(
        "Needed to make new backup codes or to turn two-factor off. Empty if you have no password.",
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" loading={isPending("codes")} onClick={() => void newCodes()}>
          Make new backup codes
        </Button>
        <Button variant="destructive" loading={isPending("off")} onClick={() => void turnOff()}>
          Turn off
        </Button>
      </div>
    </div>
  );
}
