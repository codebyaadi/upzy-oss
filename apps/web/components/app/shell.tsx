"use client";

import {
  Activity01Icon,
  AiChat02Icon,
  Alert02Icon,
  AuditIcon,
  DashboardSquare01Icon,
  File01Icon,
  Calendar03Icon,
  Globe02Icon,
  Menu01Icon,
  Notification03Icon,
  SidebarLeftIcon,
  Wifi01Icon,
  ShieldKeyIcon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { sendVerificationEmail, signOut } from "@upzy/auth/client";
import type { Role } from "@upzy/auth/roles";
import { Button } from "@upzy/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@upzy/ui/components/dropdown-menu";
import { toast } from "@upzy/ui/components/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@upzy/ui/components/tooltip";
import { cn } from "@upzy/ui/lib/utils";
import type { Route } from "next";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { Logo } from "@/components/logo";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/use-action";
import { unwrap, useApi } from "@/lib/use-api";

import { SelectField } from "./select-field";
import { useWorkspace } from "./workspace";

type NavItem = { href: Route; label: string; icon: IconSvgElement; min?: Role };
const groups: { label: string; items: NavItem[] }[] = [
  {
    label: "Overview",
    items: [{ href: "/overview", label: "All workspaces", icon: DashboardSquare01Icon }],
  },
  {
    label: "Reliability",
    items: [
      { href: "/monitors", label: "Monitors", icon: Activity01Icon },
      { href: "/incidents", label: "Incidents", icon: Alert02Icon },
      { href: "/alerts", label: "Alerts", icon: Notification03Icon },
      { href: "/maintenance", label: "Maintenance", icon: Calendar03Icon },
      { href: "/status-pages", label: "Status pages", icon: Wifi01Icon },
      { href: "/reports", label: "Client reports", icon: File01Icon, min: "admin" },
    ],
  },
  {
    label: "Security",
    items: [
      { href: "/assets", label: "Assets", icon: Globe02Icon },
      { href: "/findings", label: "Findings", icon: ShieldKeyIcon },
    ],
  },
  { label: "Assistant", items: [{ href: "/copilot", label: "Copilot", icon: AiChat02Icon }] },
  {
    label: "Workspace",
    items: [
      { href: "/team", label: "Team", icon: UserGroupIcon },
      { href: "/audit", label: "Audit", icon: AuditIcon, min: "admin" },
    ],
  },
];

const SIDEBAR_COOKIE = "upzy-sidebar";

const setCookie = (name: string, value: string) => {
  try {
    document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax${window.location.protocol === "https:" ? "; secure" : ""}`;
  } catch {}
};

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** The menu behind the avatar, in the sidebar and the phone header: account pages, appearance and sign out. */
function AccountMenuContent({
  align,
  side,
}: {
  align: "start" | "end";
  side: "top" | "bottom" | "right";
}) {
  const router = useRouter();
  const { theme = "system", setTheme } = useTheme();
  const { workspace, user, role, can } = useWorkspace();
  const [signingOut, setSigningOut] = useState(false);

  async function logout() {
    setSigningOut(true);
    await signOut();
    toast.success("Signed out");
    router.replace("/login");
  }

  return (
    <DropdownMenuContent align={align} side={side} className="w-64">
      <DropdownMenuGroup>
        <DropdownMenuLabel className="space-y-0.5">
          <span className="text-foreground block text-sm font-semibold">{user.name}</span>
          <span className="block truncate">{user.email}</span>
          <span className="block capitalize">
            {role} · {workspace.name}
          </span>
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => router.push("/team")}>Team</DropdownMenuItem>
      {can("admin") && (
        <DropdownMenuItem onClick={() => router.push("/audit")}>Audit log</DropdownMenuItem>
      )}
      <DropdownMenuItem onClick={() => router.push("/settings/account")}>Account</DropdownMenuItem>
      <DropdownMenuItem onClick={() => router.push("/settings/ai")}>AI settings</DropdownMenuItem>
      {can("admin") && (
        <DropdownMenuItem onClick={() => router.push("/settings/billing")}>
          Billing
        </DropdownMenuItem>
      )}
      {can("admin") && (
        <DropdownMenuItem onClick={() => router.push("/settings/email")}>
          Email settings
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
          <DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={signingOut} onClick={logout}>
        {signingOut ? "Signing out…" : "Sign out"}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}

/** A nudge for admins only when it matters: the trial is nearly over, or a payment needs attention. */
function BillingNotice() {
  const { can } = useWorkspace();
  const { data } = useApi(can("admin") ? "billing" : null, () => unwrap(api.billing.get()), {
    refreshInterval: 60_000,
  });
  if (!data?.enabled) return null;
  const soon = data.source === "trial" && (data.trialDaysLeft ?? 99) <= 5;
  const trouble = data.status === "past_due" || data.status === "on_hold";
  if (!soon && !trouble) return null;
  return (
    <div
      role="status"
      className="bg-accent/60 mx-auto mt-3 flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-sm"
    >
      <span>
        {trouble
          ? "A payment didn't go through. Update your payment method to keep your plan."
          : `Your Pro trial ends in ${data.trialDaysLeft} day${data.trialDaysLeft === 1 ? "" : "s"}. After that you stay on Free unless you pick a plan.`}
      </span>
      <Link href="/settings/billing" className="font-semibold underline underline-offset-4">
        {trouble ? "Fix payment" : "See plans"}
      </Link>
    </div>
  );
}

export function Shell({
  children,
  initialCollapsed = false,
}: {
  children: React.ReactNode;
  initialCollapsed?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { workspaces, workspace, setWorkspaceId, user, can } = useWorkspace();
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [dismissed, setDismissed] = useState(false);
  const [resending, setResending] = useState(false);
  const initials = initialsOf(user.name);

  function toggleCollapsed() {
    setCollapsed((c) => {
      setCookie(SIDEBAR_COOKIE, c ? "open" : "collapsed");
      return !c;
    });
  }

  // A small red count on Incidents while something is open.
  const active = useApi(
    `incidents-active:${workspace.id}`,
    () =>
      unwrap(
        api.incident.get({ query: { workspaceId: workspace.id, status: "active", limit: 50 } }),
      ),
    { refreshInterval: 30_000 },
  );
  const openIncidents = active.data?.length ?? 0;

  async function resend() {
    setResending(true);
    try {
      const { error } = await sendVerificationEmail({
        email: user.email,
        callbackURL: `${window.location.origin}/monitors`,
      });
      if (error) throw new Error(error.message);
      toast.success(`Confirmation email sent to ${user.email}`);
      setDismissed(true);
    } catch (e) {
      toast.error("Couldn't send the email", { description: errorMessage(e) });
    }
    setResending(false);
  }

  const workspacePicker = (cls: string) =>
    workspaces.length > 1 && (
      <SelectField
        aria-label="Workspace"
        size="sm"
        className={cls}
        value={workspace.id}
        onValueChange={setWorkspaceId}
        options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
      />
    );

  const count = (href: string) => (href === "/incidents" ? openIncidents : 0);

  return (
    <div className="ambient flex min-h-svh flex-col">
      {/* Phone and tablet: a flat bar with a menu button. There is room for the sidebar from the lg breakpoint up. */}
      <header className="bg-card/80 sticky top-0 z-40 border-b backdrop-blur-xl lg:hidden">
        <div className="flex h-14 items-center justify-between gap-3 px-4">
          <Link href="/monitors" aria-label="Upzy dashboard" className="shrink-0">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            {workspacePicker("hidden h-9 w-36 sm:flex")}
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Open the menu"
                className="hover:bg-accent focus-visible:ring-ring grid size-9 place-items-center rounded-xl border outline-hidden transition-colors focus-visible:ring-1"
              >
                <HugeiconsIcon icon={Menu01Icon} className="size-5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                {groups.map((g) => {
                  const shown = g.items.filter((n) => !n.min || can(n.min));
                  if (shown.length === 0) return null;
                  return (
                    <DropdownMenuGroup key={g.label}>
                      <DropdownMenuLabel>{g.label}</DropdownMenuLabel>
                      {shown.map((n) => (
                        <DropdownMenuItem
                          key={n.href}
                          className={cn(pathname.startsWith(n.href) && "bg-accent font-semibold")}
                          onClick={() => router.push(n.href)}
                        >
                          <HugeiconsIcon icon={n.icon} className="size-4" aria-hidden />
                          <span className="flex-1">{n.label}</span>
                          {count(n.href) > 0 && (
                            <span className="bg-destructive text-destructive-foreground grid min-w-5 place-items-center rounded-full px-1.5 text-[0.65rem] leading-5 font-bold">
                              {count(n.href) > 99 ? "99+" : count(n.href)}
                            </span>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="bg-primary text-primary-foreground hover:bg-primary/90 focus-visible:ring-ring grid size-9 place-items-center rounded-full text-xs font-bold outline-hidden transition-colors focus-visible:ring-1"
              >
                {initials || "?"}
              </DropdownMenuTrigger>
              <AccountMenuContent align="end" side="bottom" />
            </DropdownMenu>
          </div>
        </div>
      </header>

      {/* Floating sidebar (wide screens): a detached panel that can fold down to icons. */}
      <aside
        aria-label="Sidebar"
        className={cn(
          "bg-card/70 fixed inset-y-3 left-3 z-40 hidden flex-col rounded-3xl border p-3 shadow-[var(--shadow-panel)] backdrop-blur-xl transition-[width] duration-200 lg:flex",
          collapsed ? "w-[4.75rem]" : "w-64",
        )}
      >
        <div
          className={cn("flex items-center", collapsed ? "justify-center" : "justify-between pl-1")}
        >
          <Link href="/monitors" aria-label="Upzy dashboard">
            <Logo markOnly={collapsed} />
          </Link>
          {!collapsed && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Collapse sidebar"
              onClick={toggleCollapsed}
            >
              <HugeiconsIcon icon={SidebarLeftIcon} aria-hidden />
            </Button>
          )}
        </div>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="mx-auto mt-2"
            aria-label="Expand sidebar"
            onClick={toggleCollapsed}
          >
            <HugeiconsIcon icon={SidebarLeftIcon} className="rotate-180" aria-hidden />
          </Button>
        )}
        {!collapsed && <div className="mt-4">{workspacePicker("h-10 w-full")}</div>}
        <nav
          aria-label="Main"
          className={cn(
            "mt-4 flex flex-1 flex-col gap-4 overflow-y-auto",
            collapsed ? "scroll-hidden" : "scroll-quiet -mr-2 pr-2",
          )}
        >
          {groups.map((g) => {
            const shown = g.items.filter((n) => !n.min || can(n.min));
            if (shown.length === 0) return null;
            return (
              <div key={g.label} className="space-y-1">
                {!collapsed && (
                  <p className="text-muted-foreground px-3 pb-1 text-[0.7rem] font-semibold tracking-wide uppercase">
                    {g.label}
                  </p>
                )}
                {shown.map((n) => {
                  const isActive = pathname.startsWith(n.href);
                  const c = count(n.href);
                  const link = (
                    <Link
                      href={n.href}
                      aria-current={isActive ? "page" : undefined}
                      aria-label={collapsed ? n.label : undefined}
                      className={cn(
                        "hover:bg-accent relative flex h-10 items-center gap-3 rounded-xl text-sm font-semibold transition-colors",
                        collapsed ? "justify-center" : "px-3",
                        isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground",
                      )}
                    >
                      {isActive && !collapsed && (
                        <span
                          aria-hidden
                          className="bg-primary absolute top-2 bottom-2 -left-3 w-1 rounded-r-full"
                        />
                      )}
                      <HugeiconsIcon icon={n.icon} className="size-[1.1rem]" aria-hidden />
                      {!collapsed && <span className="flex-1">{n.label}</span>}
                      {c > 0 && (
                        <span
                          className={cn(
                            "bg-destructive text-destructive-foreground grid min-w-5 place-items-center rounded-full px-1.5 text-[0.65rem] leading-5 font-bold",
                            collapsed && "absolute top-1 right-1 min-w-4 px-1 leading-4",
                          )}
                        >
                          <span aria-hidden>{c > 99 ? "99+" : c}</span>
                          <span className="sr-only">{c} open</span>
                        </span>
                      )}
                    </Link>
                  );
                  return collapsed ? (
                    <Tooltip key={n.href}>
                      <TooltipTrigger render={link} />
                      <TooltipContent side="right">{n.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    <div key={n.href}>{link}</div>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Account menu"
            className={cn(
              "hover:bg-accent focus-visible:ring-ring flex items-center rounded-2xl border text-left outline-hidden transition-colors focus-visible:ring-1",
              collapsed ? "justify-center p-1.5" : "gap-3 p-2.5",
            )}
          >
            <span className="bg-primary text-primary-foreground grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold">
              {initials || "?"}
            </span>
            {!collapsed && (
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{user.name}</span>
                <span className="text-muted-foreground block truncate text-xs">{user.email}</span>
              </span>
            )}
          </DropdownMenuTrigger>
          <AccountMenuContent align="start" side={collapsed ? "right" : "top"} />
        </DropdownMenu>
      </aside>

      <div
        className={cn(
          "flex flex-1 flex-col transition-[padding] duration-200",
          collapsed ? "lg:pl-[6.25rem]" : "lg:pl-[17.5rem]",
        )}
      >
        <BillingNotice />
        {!user.emailVerified && !dismissed && (
          <div
            role="status"
            className="bg-accent/60 mx-auto mt-3 flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-sm"
          >
            <span>Please confirm your email address ({user.email}).</span>
            <span className="flex gap-1">
              <Button variant="ghost" size="sm" loading={resending} onClick={resend}>
                Resend email
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
                Dismiss
              </Button>
            </span>
          </div>
        )}
        <main
          key={pathname}
          className="animate-in fade-in-0 slide-in-from-bottom-1 mx-auto w-full max-w-6xl flex-1 px-4 py-10 duration-300"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
