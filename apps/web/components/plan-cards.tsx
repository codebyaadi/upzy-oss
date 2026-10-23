import { PLANS, type PlanId } from "@upzy/billing";
import { cn } from "@upzy/ui/lib/utils";

const SHOWN: PlanId[] = ["free", "starter", "pro", "agency"];

/** The bullet list for one plan, from the same limits the server enforces. */
export function planFeatures(id: PlanId): string[] {
  const l = PLANS[id].limits;
  const n = (v: number) => (Number.isFinite(v) ? String(v) : "Unlimited");
  return [
    `${n(l.monitors)} monitors, checked every ${l.minInterval / 60} min or faster`,
    `${n(l.assets)} ${l.assets === 1 ? "domain" : "domains"} with security scans`,
    `${id === "agency" ? "Many" : n(l.statusPages)} status ${l.statusPages === 1 ? "page" : "pages"}${l.customDomain ? ", on your own domain" : ""}`,
    ...(l.regions > 1 && id !== "unlimited"
      ? [`Check each monitor from up to ${l.regions} regions`]
      : []),
    ...(l.customLogo && id !== "unlimited" ? ["Your client's logo on status pages"] : []),
    ...(l.clientReports && id !== "unlimited" ? ["Scheduled reports emailed to your clients"] : []),
    "Unlimited team members",
    "Health score and fix instructions",
    "AI help on your own provider key",
  ];
}

export const price = (id: PlanId, interval: "monthly" | "yearly") => {
  const v = PLANS[id].price[interval];
  return v === 0 ? "Free" : `$${interval === "yearly" ? Math.round(v / 12) : v}`;
};

/** Plan names, prices and what each includes: shared by the public pricing page. */
export function PlanGrid({ children }: { children?: (id: PlanId) => React.ReactNode }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {SHOWN.map((id) => {
        const p = PLANS[id];
        return (
          <div
            key={id}
            className={cn(
              "bg-card/70 flex flex-col rounded-3xl border p-6 backdrop-blur",
              id === "pro" && "border-brand shadow-[var(--shadow-panel)]",
            )}
          >
            <h2 className="text-xl font-extrabold tracking-tight">{p.name}</h2>
            <p className="text-muted-foreground mt-1 min-h-10 text-sm">{p.blurb}</p>
            <p className="mt-4 text-4xl font-extrabold tracking-tighter">
              {price(id, "monthly")}
              {p.price.monthly > 0 && (
                <span className="text-muted-foreground text-sm font-medium"> / month</span>
              )}
            </p>
            <ul className="mt-5 flex-1 space-y-2 text-sm">
              {planFeatures(id).map((f) => (
                <li key={f} className="flex gap-2">
                  <span aria-hidden className="text-brand">
                    ✓
                  </span>
                  {f}
                </li>
              ))}
            </ul>
            {children?.(id)}
          </div>
        );
      })}
    </div>
  );
}
