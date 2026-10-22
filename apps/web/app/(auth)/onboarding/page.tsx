"use client";

import { organization } from "@upzy/auth/client";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { toast } from "@upzy/ui/components/sonner";
import { useState } from "react";

import { Field, PageTitle } from "@/components/app/ui";

const slugify = (s: string) =>
  `${
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "team"
  }-${Math.random().toString(36).slice(2, 6)}`;

export default function OnboardingPage() {
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name")).trim();
    setBusy(true);
    const created = await organization.create({ name, slug: slugify(name) });
    if (created.error || !created.data) {
      setBusy(false);
      return toast.error(created.error?.message ?? "Could not create the organization");
    }
    await organization.setActive({ organizationId: created.data.id });
    // Full navigation so the dashboard boots with the new active organization in the session.
    window.location.assign("/get-started");
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <PageTitle>Name your team</PageTitle>
      <div>
        <h1 className="text-2xl font-extrabold tracking-tighter">Name your team</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Monitors, incidents and alerts live inside an organization.
        </p>
      </div>
      <Field label="Organization name" htmlFor="name">
        <Input id="name" name="name" placeholder="Acme Inc." required maxLength={80} />
      </Field>
      <Button type="submit" className="w-full" size="lg" loading={busy}>
        Continue
      </Button>
    </form>
  );
}
