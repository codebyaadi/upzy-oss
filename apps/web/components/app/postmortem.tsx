"use client";

import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { toast } from "@upzy/ui/components/sonner";
import { Spinner } from "@upzy/ui/components/spinner";
import { useState } from "react";

import { Can } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { ErrorNote, Field, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

interface Content {
  customerUpdate: string;
  summary: string;
  impact: string;
  rootCause: string;
  timeline: { at: string; event: string }[];
  contributingFactors: string[];
  whatWentWell: string[];
  actionItems: { title: string; detail: string }[];
}
interface Form {
  customerUpdate: string;
  summary: string;
  impact: string;
  rootCause: string;
  timeline: string;
  contributingFactors: string;
  whatWentWell: string;
  actionItems: string;
}

const EMPTY: Content = {
  customerUpdate: "",
  summary: "",
  impact: "",
  rootCause: "",
  timeline: [],
  contributingFactors: [],
  whatWentWell: [],
  actionItems: [],
};

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
const toForm = (c: Content): Form => ({
  customerUpdate: c.customerUpdate,
  summary: c.summary,
  impact: c.impact,
  rootCause: c.rootCause,
  timeline: c.timeline.map((t) => `${t.at} | ${t.event}`).join("\n"),
  contributingFactors: c.contributingFactors.join("\n"),
  whatWentWell: c.whatWentWell.join("\n"),
  actionItems: c.actionItems.map((a) => `${a.title}: ${a.detail}`).join("\n"),
});
const fromForm = (f: Form): Content => ({
  customerUpdate: f.customerUpdate.trim(),
  summary: f.summary.trim(),
  impact: f.impact.trim(),
  rootCause: f.rootCause.trim(),
  timeline: lines(f.timeline).map((l) => {
    const i = l.indexOf(" | ");
    return i < 0 ? { at: "", event: l } : { at: l.slice(0, i), event: l.slice(i + 3) };
  }),
  contributingFactors: lines(f.contributingFactors),
  whatWentWell: lines(f.whatWentWell),
  actionItems: lines(f.actionItems).map((l) => {
    const i = l.indexOf(": ");
    return i < 0 ? { title: l, detail: "" } : { title: l.slice(0, i), detail: l.slice(i + 2) };
  }),
});

const markdown = (c: Content) =>
  [
    "# Postmortem",
    `## Summary\n${c.summary}`,
    `## Impact\n${c.impact}`,
    `## Root cause\n${c.rootCause}`,
    `## Timeline\n${c.timeline.map((t) => `- ${t.at}: ${t.event}`).join("\n")}`,
    c.contributingFactors.length
      ? `## Contributing factors\n${c.contributingFactors.map((f) => `- ${f}`).join("\n")}`
      : "",
    c.whatWentWell.length
      ? `## What went well\n${c.whatWentWell.map((f) => `- ${f}`).join("\n")}`
      : "",
    c.actionItems.length
      ? `## Action items\n${c.actionItems.map((a) => `- ${a.title}: ${a.detail}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

const AREA =
  "border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1";

/**
 * A postmortem for a resolved incident. A model can write the first draft from facts Upzy recorded, but a person
 * always reviews and saves it: nothing here is published anywhere. Everything is rendered as plain text.
 */
export function Postmortem({ incidentId }: { incidentId: string }) {
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const ai = useApi("ai-settings", () => unwrap(api.ai.settings.get()));
  const [editing, setEditing] = useState<Form | null>(null);
  const [notes, setNotes] = useState("");
  const pm = useApi(
    `postmortem:${incidentId}`,
    () => unwrap(api.incident({ id: incidentId }).postmortem.get()),
    { refreshInterval: (d) => (d?.status === "pending" ? 2_000 : 0) },
  );
  const d = pm.data;
  const content = d?.content as Content | null | undefined;
  const aiOn = ai.data?.enabled;

  async function draft() {
    if (content && !d?.aiGenerated) {
      const ok = await confirm({
        title: "Replace your text with a new draft?",
        description: "This postmortem was edited by hand. A new AI draft replaces what is there.",
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!ok) return;
    }
    await run(
      "draft",
      async () => {
        await unwrap(
          api.incident({ id: incidentId }).postmortem.post({
            replace: true,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          }),
        );
        await pm.mutate();
      },
      { error: "Couldn't start the draft" },
    );
  }

  const save = () =>
    run(
      "save",
      async () => {
        if (!editing) return;
        await unwrap(api.incident({ id: incidentId }).postmortem.put(fromForm(editing)));
        setEditing(null);
        await pm.mutate();
      },
      { success: "Postmortem saved", error: "Couldn't save the postmortem" },
    );

  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  };

  return (
    <Panel className="mt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-bold tracking-tight">Postmortem</h2>
        {content && !editing && (
          <Badge variant="secondary">
            {d?.aiGenerated ? "AI draft: review before sharing" : "Edited by hand"}
          </Badge>
        )}
      </div>
      <ErrorNote error={pm.error} />
      {!d && !pm.error && <Skeleton className="h-24 w-full rounded-2xl" />}

      {d?.status === "pending" && (
        <div role="status" aria-live="polite" className="space-y-3">
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner aria-hidden /> Writing a draft from the incident record…
          </p>
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      )}
      {d?.status === "failed" && (
        <p
          role="alert"
          className="bg-destructive/10 text-destructive mb-3 rounded-2xl px-4 py-3 text-sm"
        >
          {d.error ?? "The draft couldn't be written."}
        </p>
      )}

      {editing && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {(
            [
              [
                "customerUpdate",
                "Customer update",
                "Public and short: what happened and that it is fixed.",
                3,
              ],
              ["summary", "Summary", "", 3],
              ["impact", "Impact", "", 3],
              ["rootCause", "Root cause", 'Say "Not determined" if it isn\'t known.', 3],
              ["timeline", "Timeline", "One per line: time | event", 6],
              ["contributingFactors", "Contributing factors", "One per line.", 3],
              ["whatWentWell", "What went well", "One per line.", 3],
              ["actionItems", "Action items", "One per line: title: detail", 4],
            ] as const
          ).map(([k, label, hint, rows]) => (
            <Field key={k} label={label} htmlFor={`pm-${k}`} hint={hint || undefined}>
              <textarea
                id={`pm-${k}`}
                rows={rows}
                className={AREA}
                value={editing[k]}
                onChange={(e) => setEditing({ ...editing, [k]: e.target.value })}
              />
            </Field>
          ))}
          <div className="flex gap-2">
            <Button type="submit" loading={isPending("save")}>
              Save postmortem
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {content && !editing && d?.status !== "pending" && (
        <div className="space-y-5 text-sm">
          <div className="bg-accent/50 rounded-2xl p-4">
            <p className="text-muted-foreground mb-1 text-xs font-semibold">Customer update</p>
            <p>{content.customerUpdate}</p>
          </div>
          {(
            [
              ["Summary", content.summary],
              ["Impact", content.impact],
              ["Root cause", content.rootCause],
            ] as const
          ).map(([h, t]) => (
            <div key={h}>
              <h3 className="mb-1 font-bold">{h}</h3>
              <p className="text-muted-foreground">{t}</p>
            </div>
          ))}
          {content.timeline.length > 0 && (
            <div>
              <h3 className="mb-1 font-bold">Timeline</h3>
              <ul className="text-muted-foreground space-y-1">
                {content.timeline.map((t, i) => (
                  <li key={i}>
                    <span className="text-foreground font-mono text-xs">
                      {t.at ? dateTime(t.at) : "–"}
                    </span>{" "}
                    {t.event}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(
            [
              ["Contributing factors", content.contributingFactors],
              ["What went well", content.whatWentWell],
            ] as const
          ).map(
            ([h, items]) =>
              items.length > 0 && (
                <div key={h}>
                  <h3 className="mb-1 font-bold">{h}</h3>
                  <ul className="text-muted-foreground list-disc space-y-1 pl-5">
                    {items.map((t, i) => (
                      <li key={i}>{t}</li>
                    ))}
                  </ul>
                </div>
              ),
          )}
          {content.actionItems.length > 0 && (
            <div>
              <h3 className="mb-1 font-bold">Action items</h3>
              <ol className="text-muted-foreground list-decimal space-y-1 pl-5">
                {content.actionItems.map((a, i) => (
                  <li key={i}>
                    <strong className="text-foreground">{a.title}.</strong> {a.detail}
                  </li>
                ))}
              </ol>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            {d?.aiGenerated && d.model ? `Drafted by ${d.model}. ` : ""}
            {d?.updatedAt ? `Updated ${timeAgo(d.updatedAt)}.` : ""} The timeline comes from
            recorded events.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy(content.customerUpdate, "Customer update")}
            >
              Copy customer update
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => copy(markdown(content), "Postmortem")}
            >
              Copy as Markdown
            </Button>
          </div>
        </div>
      )}

      <Can min="member">
        {d && d.status !== "pending" && !editing && (
          <div className={content ? "mt-5 border-t pt-4" : ""}>
            {!content && (
              <p className="text-muted-foreground mb-3 text-sm">
                Write up what happened.{" "}
                {aiOn
                  ? "AI can draft it from the incident record; you review and edit it."
                  : "Turn on AI in Settings to get a first draft, or write it yourself."}
              </p>
            )}
            {aiOn && (
              <div className="mb-3 space-y-2">
                <label htmlFor="pm-notes" className="text-sm font-semibold">
                  Anything Upzy can&rsquo;t see?{" "}
                  <span className="text-muted-foreground font-normal">(optional)</span>
                </label>
                <textarea
                  id="pm-notes"
                  rows={2}
                  maxLength={2000}
                  className={AREA}
                  placeholder="e.g. A deploy went out at 10:00 and was rolled back at 10:12."
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {aiOn && (
                <Button loading={isPending("draft")} onClick={draft}>
                  {content ? "Draft again with AI" : "Draft with AI"}
                </Button>
              )}
              <Button variant="outline" onClick={() => setEditing(toForm(content ?? EMPTY))}>
                {content ? "Edit" : "Write by hand"}
              </Button>
            </div>
          </div>
        )}
      </Can>
    </Panel>
  );
}
