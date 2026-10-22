"use client";

import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

/** "Email me when something breaks". Double opt-in: the address is only used once its owner confirms. */
export function SubscribeForm({ slug }: { slug?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("sending");
    try {
      const res = await fetch("/status-subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, slug }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Couldn't sign you up. Please try again.");
      }
      setState("sent");
    } catch (err) {
      setState("idle");
      toast.error("Couldn't subscribe", { description: (err as Error).message });
    }
  }

  if (state === "sent")
    return (
      <p role="status" className="text-sm">
        <strong>Check your inbox.</strong> We sent a link to confirm your address. Until you
        confirm, you won&apos;t get any email.
      </p>
    );

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <label htmlFor="subscribe-email" className="sr-only">
        Email address
      </label>
      <Input
        id="subscribe-email"
        type="email"
        required
        maxLength={254}
        autoComplete="email"
        placeholder="you@example.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="max-w-xs min-w-48 flex-1"
      />
      <Button type="submit" loading={state === "sending"}>
        Subscribe to updates
      </Button>
    </form>
  );
}
