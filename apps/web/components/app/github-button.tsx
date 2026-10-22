"use client";

import { signIn } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";
import { useEffect, useState } from "react";

import { api } from "@/lib/api";

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.69 1.25 3.35.96.1-.74.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.69 5.39-5.25 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

/**
 * "Continue with GitHub", shown only when the server has GitHub credentials. `next` is where a returning user lands;
 * `newUserNext` is where someone who has just created an account lands.
 */
export function GithubButton({ next, newUserNext }: { next: string; newUserNext: string }) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api["auth-providers"]
      .get()
      .then(({ data }) => live && setEnabled(!!data && "github" in data && data.github))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!enabled) return null;

  async function go() {
    setBusy(true);
    const { error } = await signIn.social({
      provider: "github",
      callbackURL: `${window.location.origin}${next}`,
      newUserCallbackURL: `${window.location.origin}${newUserNext}`,
      errorCallbackURL: `${window.location.origin}/login`,
    });
    // On success the browser is already navigating to GitHub.
    if (error) {
      setBusy(false);
      toast.error(error.message ?? "Could not start GitHub sign-in");
    }
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        size="lg"
        loading={busy}
        onClick={go}
      >
        <GithubMark />
        Continue with GitHub
      </Button>
      <div className="text-muted-foreground flex items-center gap-3 text-xs">
        <span className="bg-border h-px flex-1" />
        or
        <span className="bg-border h-px flex-1" />
      </div>
    </>
  );
}
