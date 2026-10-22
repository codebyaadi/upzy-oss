"use client";

import { useSession, organization } from "@upzy/auth/client";
import { effectiveRole, hasRole, type Role } from "@upzy/auth/roles";
import { Skeleton } from "@upzy/ui/components/skeleton";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

import { ListSkeleton } from "@/components/app/ui";
import { api } from "@/lib/api";
import { unwrap, useApi } from "@/lib/use-api";

interface Workspace {
  id: string;
  name: string;
}
interface Ctx {
  workspaces: Workspace[];
  workspace: Workspace;
  setWorkspaceId: (id: string) => void;
  user: { id: string; name: string; email: string; emailVerified: boolean };
  orgId: string;
  /** The caller's role in the active organization. */
  role: Role;
  /** Whether the caller's role is at least `minimum`. The API enforces this too: this only hides what would be refused. */
  can: (minimum: Role) => boolean;
}

const WorkspaceContext = createContext<Ctx | null>(null);
export const useWorkspace = () => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside <WorkspaceProvider>");
  return ctx;
};

const STORAGE_KEY = "upzy.workspace";

/** Gates the app on a session + active organization, then provides the selected workspace. */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = useSession();
  const [selected, setSelected] = useState<string | null>(null);
  const orgId = session?.session.activeOrganizationId ?? null;

  useEffect(() => {
    try {
      setSelected(localStorage.getItem(STORAGE_KEY));
    } catch {}
  }, []);

  // Session / organization gate.
  useEffect(() => {
    if (isPending) return;
    if (!session) return void router.replace("/login");
    if (orgId) return;
    void organization.list().then(async ({ data }) => {
      const first = data?.[0];
      if (!first) return router.replace("/onboarding");
      await organization.setActive({ organizationId: first.id });
      router.refresh();
      window.location.reload();
    });
  }, [isPending, session, orgId, router]);

  const { data: roleData } = useApi(orgId ? `role:${orgId}` : null, async () => {
    const { data } = await organization.getActiveMemberRole();
    return effectiveRole(data?.role) ?? "viewer";
  });

  const { data: workspaces, mutate } = useApi(orgId ? `workspaces:${orgId}` : null, () =>
    unwrap(api.workspace.get()),
  );

  // A fresh organization has no workspace yet: create the default one.
  useEffect(() => {
    if (workspaces && workspaces.length === 0) {
      void unwrap(api.workspace.post({ name: "Default" })).then(() => mutate());
    }
  }, [workspaces, mutate]);

  const setWorkspaceId = useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {}
  }, []);

  const value = useMemo<Ctx | null>(() => {
    if (!session || !workspaces || workspaces.length === 0 || !roleData || !orgId) return null;
    const workspace = workspaces.find((w) => w.id === selected) ?? workspaces[0]!;
    const role = roleData;
    return {
      workspaces,
      workspace,
      setWorkspaceId,
      user: session.user,
      orgId,
      role,
      can: (min) => hasRole(role, min),
    };
  }, [session, workspaces, selected, setWorkspaceId, roleData, orgId]);

  if (!value) return <AppLoading />;
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}

/** Shown while the session, role and workspace load: the dashboard's shape, not a blank screen. */
function AppLoading() {
  return (
    <div className="ambient min-h-svh" role="status" aria-label="Loading your workspace">
      <div className="px-3 pt-3">
        <div className="bg-card/70 mx-auto flex h-14 max-w-6xl items-center justify-between rounded-full border pr-4 pl-4 shadow-[var(--shadow-panel)] backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-9 rounded-xl" />
            <Skeleton className="h-5 w-16" />
          </div>
          <Skeleton className="hidden h-8 w-72 rounded-full sm:block" />
          <Skeleton className="size-9 rounded-full" />
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Skeleton className="mb-8 h-10 w-64" />
        <ListSkeleton />
      </main>
    </div>
  );
}
