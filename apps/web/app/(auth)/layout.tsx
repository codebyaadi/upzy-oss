import type { Metadata } from "next";
import Link from "next/link";

import { GuestRedirect } from "@/components/auth-aware";
import { BuiltBy } from "@/components/built-by";
import { Logo } from "@/components/logo";

export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="ambient grid min-h-svh place-items-center px-4 py-12">
      <GuestRedirect />
      <div className="w-full max-w-md">
        <Link href="/" aria-label="Upzy home" className="mb-8 flex justify-center">
          <Logo />
        </Link>
        <div className="bg-card/70 rounded-3xl border p-8 shadow-[var(--shadow-panel)] backdrop-blur-xl">
          {children}
        </div>
        <div className="mt-8 flex justify-center">
          <BuiltBy />
        </div>
      </div>
    </div>
  );
}
