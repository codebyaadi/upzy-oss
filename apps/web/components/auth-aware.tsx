"use client";

import { useSession } from "@upzy/auth/client";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { ButtonLink } from "@/components/button-link";
import { safeNext } from "@/lib/next-path";

/** Whether there is a signed-in session. `pending` is true until the browser has asked. */
export function useSignedIn() {
  const { data, isPending } = useSession();
  return { signedIn: !!data, pending: isPending };
}

/** Pages that make no sense once you are signed in. (Reset-password stays reachable: it works from an emailed link.) */
const GUEST_ONLY = ["/login", "/sign-up", "/forgot-password"];

/**
 * Sends a signed-in person away from the sign-in, sign-up and forgot-password pages, to where they were headed
 * (`?next=`) or the dashboard. It needs a real session, not just a cookie: an expired cookie must not bounce
 * someone between this page and the app's own sign-in gate.
 */
export function GuestRedirect() {
  const router = useRouter();
  const pathname = usePathname();
  const { signedIn } = useSignedIn();
  useEffect(() => {
    if (!signedIn || !GUEST_ONLY.includes(pathname)) return;
    router.replace(safeNext(new URLSearchParams(window.location.search).get("next")));
  }, [signedIn, pathname, router]);
  return null;
}

/**
 * The landing page's main call to action: "Get started" for visitors, "Dashboard" for people who are signed in.
 * While the browser is still finding out it keeps its place invisibly, so nothing jumps.
 */
export function PrimaryCta({
  guestLabel = "Get started free",
  signedInLabel = "Open dashboard",
  size,
  className,
  children,
}: {
  guestLabel?: string;
  signedInLabel?: string;
  size?: "sm" | "lg" | "default";
  className?: string;
  children?: React.ReactNode;
}) {
  const { signedIn, pending } = useSignedIn();
  return (
    <ButtonLink
      size={size}
      className={`${className ?? ""} ${pending ? "invisible" : ""}`}
      href={signedIn ? "/monitors" : "/sign-up"}
    >
      {signedIn ? signedInLabel : guestLabel}
      {children}
    </ButtonLink>
  );
}

/** The two buttons at the right of the landing nav. */
export function NavActions() {
  const { signedIn, pending } = useSignedIn();
  return (
    <div className={`flex items-center gap-1 ${pending ? "invisible" : ""}`}>
      {!signedIn && (
        <ButtonLink variant="ghost" size="sm" href="/login" className="hidden sm:inline-flex">
          Sign in
        </ButtonLink>
      )}
      <ButtonLink size="sm" href={signedIn ? "/monitors" : "/sign-up"}>
        {signedIn ? "Dashboard" : "Get started"}
      </ButtonLink>
    </div>
  );
}
