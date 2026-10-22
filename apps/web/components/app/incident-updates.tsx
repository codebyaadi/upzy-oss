"use client";

import { Button } from "@upzy/ui/components/button";
import { useState } from "react";

import { Can } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { SelectField } from "@/components/app/select-field";
import { Field, Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap } from "@/lib/use-api";

export type UpdateStatus = "investigating" | "identified" | "monitoring" | "update";

export const UPDATE_LABEL: Record<UpdateStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  update: "Update",
};

const AREA =
  "border-input focus-visible:ring-ring w-full resize-y rounded-2xl border bg-transparent px-4 py-3 text-sm outline-hidden focus-visible:ring-1";

interface Item {
  id: string;
  status: UpdateStatus;
  message: string;
  createdAt: string | Date;
}

/** Messages for customers: shown on public status pages that list this incident's monitor. */
export function IncidentUpdates({
  incidentId,
  updates,
  onChanged,
}: {
  incidentId: string;
  updates: Item[];
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [status, setStatus] = useState<UpdateStatus>(
    updates.length === 0 ? "investigating" : "update",
  );
  const [message, setMessage] = useState("");

  const post = () =>
    run(
      "post",
      async () => {
        await unwrap(api.incident({ id: incidentId }).updates.post({ status, message }));
        setMessage("");
        setStatus("update");
        onChanged();
      },
      { success: "Update posted to your status pages", error: "Couldn't post the update" },
    );

  const remove = async (u: Item) => {
    const ok = await confirm({
      title: "Remove this update?",
      description: "It disappears from your public status pages straight away.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    await run(
      `del:${u.id}`,
      async () => {
        await unwrap(api.incident({ id: incidentId }).updates({ updateId: u.id }).delete());
        onChanged();
      },
      { success: "Update removed", error: "Couldn't remove the update" },
    );
  };

  return (
    <Panel className="mb-4">
      <h2 className="text-xl font-bold tracking-tight">Updates for customers</h2>
      <p className="text-muted-foreground mt-1 mb-5 text-sm">
        Written by you, shown on any public status page that includes this monitor. Don&apos;t
        include internal details.
      </p>
      <Can min="member">
        <div className="mb-6 grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <Field label="Stage" htmlFor="iu-status">
              <SelectField
                id="iu-status"
                value={status}
                onValueChange={(v) => setStatus(v as UpdateStatus)}
                options={(Object.keys(UPDATE_LABEL) as UpdateStatus[]).map((value) => ({
                  value,
                  label: UPDATE_LABEL[value],
                }))}
              />
            </Field>
            <Field label="Message" htmlFor="iu-message">
              <textarea
                id="iu-message"
                rows={3}
                maxLength={2000}
                className={AREA}
                placeholder="We're seeing elevated errors and are looking into it."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </Field>
          </div>
          <div>
            <Button loading={isPending("post")} disabled={!message.trim()} onClick={post}>
              Post update
            </Button>
          </div>
        </div>
      </Can>
      {updates.length === 0 ? (
        <p className="text-muted-foreground text-sm">Nothing posted yet.</p>
      ) : (
        <ul className="divide-y">
          {updates.map((u) => (
            <li key={u.id} className="flex items-start justify-between gap-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-semibold">{UPDATE_LABEL[u.status]}</p>
                <p className="mt-0.5 break-words whitespace-pre-wrap">{u.message}</p>
                <p className="text-muted-foreground mt-1 text-xs">{dateTime(u.createdAt)}</p>
              </div>
              <Can min="member">
                <Button
                  variant="ghost"
                  size="sm"
                  loading={isPending(`del:${u.id}`)}
                  onClick={() => remove(u)}
                >
                  Remove
                </Button>
              </Can>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
