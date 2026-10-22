"use client";

import { Button } from "@upzy/ui/components/button";
import { toast } from "@upzy/ui/components/sonner";

import { Can } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { Panel } from "@/components/app/ui";
import { api } from "@/lib/api";
import { dateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { unwrap } from "@/lib/use-api";

const human = (s: number) =>
  s < 3600
    ? `${Math.round(s / 60)} min`
    : s < 86_400
      ? `${Math.round(s / 3600)} h`
      : `${Math.round(s / 86_400)} d`;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Copied");
  } catch {
    toast.error("Couldn't copy", { description: "Select the text and copy it by hand." });
  }
}

/** How to report in, and when the job last did. The ping address is only shown to people who may use it. */
export function HeartbeatPanel({
  id,
  pingUrl,
  config,
  lastPingAt,
  lastFailAt,
  onChanged,
}: {
  id: string;
  pingUrl: string | null | undefined;
  config: { expectEvery?: number; grace?: number };
  lastPingAt: string | Date | null;
  lastFailAt: string | Date | null;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const rotate = async () => {
    const ok = await confirm({
      title: "Create a new ping address?",
      description:
        "The current address stops working immediately. Update your job with the new one.",
      confirmLabel: "Create new address",
      destructive: true,
    });
    if (!ok) return;
    await run(
      "rotate",
      async () => {
        await unwrap(api.monitor({ id })["rotate-token"].post());
        onChanged();
      },
      { success: "New ping address created", error: "Couldn't create a new address" },
    );
  };

  const cron = pingUrl
    ? `# every hour, and only if the job succeeded:\n0 * * * * /path/to/job.sh && curl -fsS -m 10 --retry 3 ${pingUrl} >/dev/null`
    : "";
  const withFail = pingUrl
    ? `/path/to/job.sh && curl -fsS -m 10 --retry 3 ${pingUrl} || curl -fsS -m 10 ${pingUrl}/fail`
    : "";

  return (
    <Panel className="mt-4">
      <h2 className="text-xl font-bold tracking-tight">Heartbeat</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        Expected every {config.expectEvery ? human(config.expectEvery) : "?"}, alerting after{" "}
        {config.grace ? human(config.grace) : "no"} extra. Last ping{" "}
        <strong className="text-foreground">{lastPingAt ? timeAgo(lastPingAt) : "never"}</strong>
        {lastPingAt && <span> ({dateTime(lastPingAt)})</span>}
        {lastFailAt && lastPingAt && new Date(lastFailAt) > new Date(lastPingAt) && (
          <span className="text-destructive">
            {" "}
            · the job reported a failure {timeAgo(lastFailAt)}
          </span>
        )}
        .
      </p>
      {pingUrl ? (
        <div className="mt-4 space-y-4">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-sm font-semibold">Ping address</span>
              <Button variant="ghost" size="sm" onClick={() => copy(pingUrl)}>
                Copy
              </Button>
            </div>
            <pre className="bg-muted overflow-x-auto rounded-xl px-3 py-2.5 font-mono text-xs break-all whitespace-pre-wrap">
              {pingUrl}
            </pre>
            <p className="text-muted-foreground mt-1 text-xs">
              Any request works (GET or POST). Anyone who has this address can report as your job,
              so keep it private.
            </p>
          </div>
          {[
            ["Cron job", cron],
            ["Tell us when it fails too", withFail],
          ].map(([label, code]) => (
            <div key={label}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="text-sm font-semibold">{label}</span>
                <Button variant="ghost" size="sm" onClick={() => copy(code!)}>
                  Copy
                </Button>
              </div>
              <pre className="bg-muted overflow-x-auto rounded-xl px-3 py-2.5 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">
                {code}
              </pre>
            </div>
          ))}
          <Can min="member">
            <Button variant="outline" size="sm" loading={isPending("rotate")} onClick={rotate}>
              Create a new address
            </Button>
          </Can>
        </div>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">
          The ping address is shown to members and admins.
        </p>
      )}
    </Panel>
  );
}
