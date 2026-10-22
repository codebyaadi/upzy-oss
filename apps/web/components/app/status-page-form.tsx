"use client";

import { Button } from "@upzy/ui/components/button";
import { Checkbox } from "@upzy/ui/components/checkbox";
import { Input } from "@upzy/ui/components/input";
import { Switch } from "@upzy/ui/components/switch";
import { useMemo, useState } from "react";

import { SelectField } from "@/components/app/select-field";
import { Field, Panel } from "@/components/app/ui";

export interface StatusPageDraft {
  title: string;
  slug: string;
  description: string;
  published: boolean;
  notice: string;
  noticeKind: "info" | "maintenance" | "incident";
  components: { monitorId: string; displayName: string }[];
  /** Empty means none. Only offered once the page exists, because verifying it needs the saved page. */
  customDomain: string;
  /** The asset whose security grade the public page shows. Empty means none. */
  securityAssetId: string;
  /** An https image address. Empty means none. */
  logoUrl: string;
}

const AREA =
  "border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

/** Create or edit a status page: its address, the notice, and which monitors appear under which public names. */
export function StatusPageForm({
  initial,
  monitors,
  assets,
  saving,
  onSave,
  onCancel,
  isNew,
}: {
  initial: StatusPageDraft;
  monitors: { id: string; name: string }[];
  assets: { id: string; value: string }[];
  saving: boolean;
  isNew: boolean;
  onSave: (draft: StatusPageDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const chosen = useMemo(() => new Map(d.components.map((c) => [c.monitorId, c])), [d.components]);
  const unchosen = monitors.filter((m) => !chosen.has(m.id));
  const nameOf = (id: string) => monitors.find((m) => m.id === id)?.name ?? "(deleted monitor)";

  const move = (i: number, by: -1 | 1) =>
    setD((x) => {
      const next = [...x.components];
      const j = i + by;
      if (j < 0 || j >= next.length) return x;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return { ...x, components: next };
    });
  const rename = (id: string, displayName: string) =>
    setD((x) => ({
      ...x,
      components: x.components.map((c) => (c.monitorId === id ? { ...c, displayName } : c)),
    }));
  const toggle = (m: { id: string; name: string }, on: boolean) =>
    setD((x) => ({
      ...x,
      components: on
        ? [...x.components, { monitorId: m.id, displayName: m.name }]
        : x.components.filter((c) => c.monitorId !== m.id),
    }));

  return (
    <Panel>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({
            ...d,
            components: d.components.map((c) => ({ ...c, displayName: c.displayName.trim() })),
          });
        }}
      >
        <h2 className="text-xl font-bold tracking-tight">
          {isNew ? "New status page" : "Edit status page"}
        </h2>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Title" htmlFor="sp-title">
            <Input
              id="sp-title"
              value={d.title}
              maxLength={80}
              required
              placeholder="Acme status"
              onChange={(e) => {
                const title = e.target.value;
                setD((x) => ({ ...x, title, slug: slugTouched ? x.slug : slugify(title) }));
              }}
            />
          </Field>
          <Field
            label="Address"
            htmlFor="sp-slug"
            hint={`${origin}/status/${d.slug || "your-address"}`}
          >
            <Input
              id="sp-slug"
              value={d.slug}
              minLength={3}
              maxLength={40}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              title="Lowercase letters, digits and single hyphens"
              onChange={(e) => {
                setSlugTouched(true);
                setD((x) => ({ ...x, slug: e.target.value.toLowerCase() }));
              }}
            />
          </Field>
        </div>

        <Field
          label="Description (optional)"
          htmlFor="sp-desc"
          hint="Shown under the title. Plain text."
        >
          <Input
            id="sp-desc"
            value={d.description}
            maxLength={300}
            onChange={(e) => setD((x) => ({ ...x, description: e.target.value }))}
          />
        </Field>

        {!isNew && (
          <Field
            label="Custom domain (optional)"
            htmlFor="sp-domain"
            hint="Serve this page on your own address, such as status.example.com. After saving you'll get two DNS records to add."
          >
            <Input
              id="sp-domain"
              value={d.customDomain}
              maxLength={253}
              placeholder="status.example.com"
              onChange={(e) =>
                setD((x) => ({ ...x, customDomain: e.target.value.trim().toLowerCase() }))
              }
            />
          </Field>
        )}

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">What to show</legend>
          <p className="text-muted-foreground text-xs">
            Only the public name and whether each is up appear on the page: never the
            monitor&rsquo;s address or any error text.
          </p>
          {d.components.length > 0 && (
            <ol className="space-y-2">
              {d.components.map((c, i) => (
                <li
                  key={c.monitorId}
                  className="flex items-center gap-2 rounded-2xl border p-2 pl-3"
                >
                  <span
                    className="text-muted-foreground w-32 shrink-0 truncate text-xs"
                    title={nameOf(c.monitorId)}
                  >
                    {nameOf(c.monitorId)}
                  </span>
                  <Input
                    aria-label={`Public name for ${nameOf(c.monitorId)}`}
                    value={c.displayName}
                    maxLength={60}
                    required
                    onChange={(e) => rename(c.monitorId, e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Move down"
                    disabled={i === d.components.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => toggle({ id: c.monitorId, name: "" }, false)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ol>
          )}
          {unchosen.length > 0 ? (
            <div className="space-y-1.5">
              <p className="text-muted-foreground text-xs">Add a monitor</p>
              {unchosen.map((m) => (
                <label
                  key={m.id}
                  className="hover:bg-accent/40 flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 text-sm"
                >
                  <Checkbox checked={false} onCheckedChange={(on) => on && toggle(m, true)} />
                  {m.name}
                </label>
              ))}
            </div>
          ) : (
            monitors.length === 0 && (
              <p className="text-muted-foreground text-sm">
                Create a monitor first, then add it here.
              </p>
            )
          )}
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-[12rem_1fr]">
          <Field label="Notice" htmlFor="sp-kind">
            <SelectField
              id="sp-kind"
              value={d.noticeKind}
              onValueChange={(v) => setD((x) => ({ ...x, noticeKind: v }))}
              options={[
                { value: "info", label: "Information" },
                { value: "maintenance", label: "Maintenance" },
                { value: "incident", label: "Known issue" },
              ]}
            />
          </Field>
          <Field
            label="Message (optional)"
            htmlFor="sp-notice"
            hint="Pinned above the components. Plain text, up to 500 characters."
          >
            <textarea
              id="sp-notice"
              rows={2}
              maxLength={500}
              className={AREA}
              value={d.notice}
              onChange={(e) => setD((x) => ({ ...x, notice: e.target.value }))}
            />
          </Field>
        </div>

        <Field
          label="Show a security grade (optional)"
          htmlFor="sp-security"
          hint="Adds “Security grade A” to the public page and lets you embed a badge. Only the letter and the date of the last check are shown, never what was found."
        >
          <SelectField
            id="sp-security"
            value={d.securityAssetId || "none"}
            onValueChange={(v) => setD((x) => ({ ...x, securityAssetId: v === "none" ? "" : v }))}
            options={[
              { value: "none", label: "Don't show a grade" },
              ...assets.map((a) => ({ value: a.id, label: a.value })),
            ]}
          />
        </Field>

        <Field
          label="Your client's logo (Agency plan, optional)"
          htmlFor="sp-logo"
          hint="The full https:// address of an image. It appears above the page title; “Powered by Upzy” stays at the bottom."
        >
          <Input
            id="sp-logo"
            type="url"
            value={d.logoUrl}
            maxLength={500}
            placeholder="https://client.com/logo.png"
            onChange={(e) => setD((x) => ({ ...x, logoUrl: e.target.value.trim() }))}
          />
        </Field>

        <label className="flex items-center justify-between gap-4 rounded-2xl border p-4">
          <span>
            <span className="block text-sm font-semibold">Published</span>
            <span className="text-muted-foreground block text-xs">
              Anyone with the link can see the page. Leave off while you set it up.
            </span>
          </span>
          <Switch
            aria-label="Published"
            checked={d.published}
            onCheckedChange={(published) => setD((x) => ({ ...x, published }))}
          />
        </label>

        <div className="flex gap-2">
          <Button type="submit" loading={saving}>
            {isNew ? "Create status page" : "Save changes"}
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Panel>
  );
}
