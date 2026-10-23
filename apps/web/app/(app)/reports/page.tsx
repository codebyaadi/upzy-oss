"use client";

import { Button } from "@upzy/ui/components/button";
import { Switch } from "@upzy/ui/components/switch";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ViewOnlyNote } from "@/components/app/can";
import { SelectField } from "@/components/app/select-field";
import { SetupChecklist } from "@/components/app/setup-checklist";
import { ErrorNote, Field, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { api } from "@/lib/api";
import { useAction } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

const AREA =
  "border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1";

/** A recurring uptime and security report for this workspace, emailed to the client. */
export default function ReportsPage() {
  const { workspace, can } = useWorkspace();
  const { run, isPending } = useAction();
  const report = useApi(can("admin") ? `report:${workspace.id}` : null, () =>
    unwrap(api.reports.get({ query: { workspaceId: workspace.id } })),
  );
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [text, setText] = useState("");

  // Fill the form from the saved settings whenever they load or the workspace changes.
  useEffect(() => {
    const d = report.data;
    if (!d) return;
    setEnabled(d.enabled);
    setFrequency(d.frequency);
    setText(d.recipients.map((r) => r.email).join("\n"));
  }, [report.data, workspace.id]);

  const emails = [
    ...new Set(
      text
        .split(/[\s,;]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const optedOut = new Set(
    report.data?.recipients.filter((r) => r.unsubscribed).map((r) => r.email),
  );

  const save = () =>
    run(
      "save",
      async () => {
        await unwrap(
          api.reports.put({ workspaceId: workspace.id, enabled, frequency, recipients: emails }),
        );
        await report.mutate();
      },
      { success: "Report settings saved", error: "Couldn't save the report settings" },
    );

  const test = () =>
    run(
      "test",
      async () => {
        const r = await unwrap(api.reports.test.post({ workspaceId: workspace.id }));
        return r.to;
      },
      {
        success: (to) => `A test report is on its way to ${to}`,
        error: "Couldn't send the test report",
      },
    );

  return (
    <>
      <PageHeader
        title="Client reports"
        description={`A plain uptime and security summary for ${workspace.name}, emailed on a schedule to the people you list.`}
      />
      {!can("admin") && <ViewOnlyNote what="client reports" />}
      <ErrorNote error={report.error} />

      {can("admin") && report.data && (
        <SetupChecklist
          title="Send your first client report"
          steps={[
            {
              label: "Add the people who should get it",
              hint: "Type their addresses under Recipients, then Save.",
              done: report.data.recipients.length > 0,
            },
            {
              label: "Switch reports on",
              hint: "Choose weekly or monthly and turn on Send reports.",
              done: report.data.enabled,
            },
          ]}
        />
      )}

      {can("admin") && (
        <div className="grid max-w-5xl gap-4 lg:grid-cols-[1fr_20rem]">
          <Panel>
            {report.data && !report.data.available && (
              <p role="status" className="bg-accent/60 mb-5 rounded-2xl px-4 py-3 text-sm">
                Scheduled client reports are part of the Agency plan.{" "}
                <Link
                  href="/settings/billing"
                  className="font-semibold underline underline-offset-4"
                >
                  See plans
                </Link>
                .
              </p>
            )}
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label className="flex items-start justify-between gap-4 text-sm">
                <span>
                  <span className="font-semibold">Send reports for {workspace.name}</span>
                  <span className="text-muted-foreground block text-xs">
                    One email per recipient, after each finished period.
                  </span>
                </span>
                <Switch aria-label="Send reports" checked={enabled} onCheckedChange={setEnabled} />
              </label>

              <Field label="How often" htmlFor="rp-frequency">
                <SelectField
                  id="rp-frequency"
                  value={frequency}
                  onValueChange={setFrequency}
                  options={[
                    { value: "monthly", label: "Monthly, on the 1st (covers the month before)" },
                    { value: "weekly", label: "Weekly, on Monday (covers Monday to Sunday)" },
                  ]}
                />
              </Field>

              <Field
                label="Recipients"
                htmlFor="rp-recipients"
                hint={`One address per line, up to ${report.data?.maxRecipients ?? 10}. Each email has its own unsubscribe link, and someone who unsubscribes stays unsubscribed.`}
              >
                <textarea
                  id="rp-recipients"
                  className={AREA}
                  rows={5}
                  value={text}
                  placeholder="client@example.com"
                  onChange={(e) => setText(e.target.value)}
                />
              </Field>
              {emails.some((e) => optedOut.has(e)) && (
                <p className="text-muted-foreground text-xs">
                  Not sent to, because they unsubscribed:{" "}
                  {emails.filter((e) => optedOut.has(e)).join(", ")}.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button type="submit" loading={isPending("save")}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  loading={isPending("test")}
                  disabled={!report.data?.available}
                  onClick={() => void test()}
                >
                  Send me a test report
                </Button>
              </div>
            </form>
          </Panel>

          <Panel className="h-fit">
            <h2 className="mb-3 text-xl font-bold tracking-tight">What the client sees</h2>
            <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>Overall uptime and uptime for each service.</li>
              <li>How many incidents, and the total downtime.</li>
              <li>The security grade and how many issues were fixed, new and open.</li>
              <li>A link to the live status page, if one is published.</li>
            </ul>
            <p className="text-muted-foreground mt-4 text-sm leading-relaxed">
              It never lists what was found, monitor addresses or error messages, and it says it was
              prepared by your organization. Use the test report to see exactly what they get.
            </p>
          </Panel>
        </div>
      )}
    </>
  );
}
