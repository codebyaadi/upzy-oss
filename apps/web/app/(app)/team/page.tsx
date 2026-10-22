"use client";

import { organization } from "@upzy/auth/client";
import { effectiveRole, type Role } from "@upzy/auth/roles";
import { Badge } from "@upzy/ui/components/badge";
import { Button } from "@upzy/ui/components/button";
import { Input } from "@upzy/ui/components/input";
import { useState } from "react";

import { ActionMenu } from "@/components/app/action-menu";
import { Can } from "@/components/app/can";
import { useConfirm } from "@/components/app/confirm";
import { SelectField } from "@/components/app/select-field";
import { ErrorNote, Field, ListSkeleton, PageHeader, Panel } from "@/components/app/ui";
import { useWorkspace } from "@/components/app/workspace";
import { dateTime, timeAgo } from "@/lib/format";
import { useAction } from "@/lib/use-action";
import { useApi } from "@/lib/use-api";

const ROLE_HELP: { role: Role; summary: string }[] = [
  { role: "viewer", summary: "Read-only: sees monitors, incidents, findings and alerts." },
  {
    role: "member",
    summary: "Also creates and changes monitors, assets and findings, and acknowledges incidents.",
  },
  {
    role: "admin",
    summary: "Also manages notification channels, alert rules, the team and the audit log.",
  },
  {
    role: "owner",
    summary: "Everything, including other owners. Only owners can change an owner.",
  },
];

/** better-auth client calls resolve with `{ error }` instead of throwing; turn that into a throw for useAction. */
async function ok<T extends { error?: { message?: string } | null }>(p: Promise<T>): Promise<T> {
  const res = await p;
  if (res.error) throw new Error(res.error.message ?? "Something went wrong");
  return res;
}

export default function TeamPage() {
  const { orgId, user, role: myRole, can } = useWorkspace();
  const confirm = useConfirm();
  const { run, isPending } = useAction();
  const [inviteRole, setInviteRole] = useState<Role>("member");

  const org = useApi(`team:${orgId}`, async () => {
    const { data, error } = await organization.getFullOrganization({
      query: { organizationId: orgId },
    });
    if (error || !data) throw new Error(error?.message ?? "Could not load the team");
    return data;
  });

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email")).trim();
    const done = await run(
      "invite",
      async () => {
        await ok(organization.inviteMember({ email, role: inviteRole, organizationId: orgId }));
        await org.mutate();
        return true;
      },
      { success: `Invitation sent to ${email}`, error: "Couldn't send the invitation" },
    );
    if (done) form.reset();
  }

  const changeRole = (memberId: string, name: string, role: Role) =>
    run(
      `role:${memberId}`,
      async () => {
        await ok(organization.updateMemberRole({ memberId, role, organizationId: orgId }));
        await org.mutate();
      },
      { success: `${name} is now ${role}`, error: "Couldn't change the role" },
    );

  async function removeMember(memberId: string, name: string) {
    const confirmed = await confirm({
      title: `Remove ${name}?`,
      description:
        "They lose access to this organization immediately. They can be invited again later.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!confirmed) return;
    await run(
      `remove:${memberId}`,
      async () => {
        await ok(organization.removeMember({ memberIdOrEmail: memberId, organizationId: orgId }));
        await org.mutate();
      },
      { success: `${name} was removed`, error: "Couldn't remove the member" },
    );
  }

  const cancelInvitation = (invitationId: string, email: string) =>
    run(
      `cancel:${invitationId}`,
      async () => {
        await ok(organization.cancelInvitation({ invitationId }));
        await org.mutate();
      },
      { success: `Invitation to ${email} cancelled`, error: "Couldn't cancel the invitation" },
    );

  const members = org.data?.members ?? [];
  const pending = (org.data?.invitations ?? []).filter((i) => i.status === "pending");
  // Only an owner may touch an owner; nobody changes their own role from here.
  const canManage = (target: { userId: string; role: string }) =>
    can("admin") &&
    target.userId !== user.id &&
    (effectiveRole(target.role) !== "owner" || myRole === "owner");
  const assignable: Role[] =
    myRole === "owner" ? ["viewer", "member", "admin", "owner"] : ["viewer", "member", "admin"];
  const roleOptions = (roles: Role[]) =>
    roles.map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }));

  return (
    <>
      <PageHeader title="Team" description="Who can see and change things in this organization." />
      <ErrorNote error={org.error} />

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <Panel>
            <h2 className="mb-4 text-xl font-bold tracking-tight">
              Members{org.data ? ` (${members.length})` : ""}
            </h2>
            {org.isLoading && !org.data && <ListSkeleton rows={2} />}
            <ul className="divide-y">
              {members.map((m) => {
                const manageable = canManage(m);
                const current = effectiveRole(m.role) ?? "viewer";
                return (
                  <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 font-semibold">
                        {m.user.name}
                        {m.userId === user.id && <Badge variant="secondary">You</Badge>}
                      </p>
                      <p className="text-muted-foreground truncate text-sm">{m.user.email}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {manageable ? (
                        <>
                          <SelectField
                            aria-label={`Role for ${m.user.name}`}
                            className="w-32"
                            value={current}
                            disabled={isPending(`role:${m.id}`)}
                            onValueChange={(r) => r !== current && changeRole(m.id, m.user.name, r)}
                            options={roleOptions(assignable)}
                          />
                          <ActionMenu
                            label={`Actions for ${m.user.name}`}
                            actions={[
                              {
                                label: "Remove from organization",
                                destructive: true,
                                onSelect: () => removeMember(m.id, m.user.name),
                              },
                            ]}
                          />
                        </>
                      ) : (
                        <Badge variant="outline" className="capitalize">
                          {current}
                        </Badge>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>

          {pending.length > 0 && (
            <Panel>
              <h2 className="mb-4 text-xl font-bold tracking-tight">Pending invitations</h2>
              <ul className="divide-y">
                {pending.map((i) => (
                  <li
                    key={i.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                  >
                    <span>
                      <span className="font-semibold">{i.email}</span> as{" "}
                      <span className="capitalize">{i.role}</span>
                      <span className="text-muted-foreground block text-xs">
                        invited {timeAgo(i.createdAt)} · expires {dateTime(i.expiresAt)}
                      </span>
                    </span>
                    <Can min="admin">
                      <Button
                        variant="ghost"
                        size="sm"
                        loading={isPending(`cancel:${i.id}`)}
                        onClick={() => cancelInvitation(i.id, i.email)}
                      >
                        Cancel
                      </Button>
                    </Can>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel>
            <h2 className="mb-3 text-xl font-bold tracking-tight">What each role can do</h2>
            <dl className="space-y-2 text-sm">
              {ROLE_HELP.map((r) => (
                <div key={r.role} className="grid grid-cols-[5rem_1fr] gap-3">
                  <dt className="font-semibold capitalize">{r.role}</dt>
                  <dd className="text-muted-foreground">{r.summary}</dd>
                </div>
              ))}
            </dl>
          </Panel>
        </div>

        <Can min="admin">
          <Panel className="h-fit">
            <h2 className="mb-4 text-xl font-bold tracking-tight">Invite someone</h2>
            <form onSubmit={invite} className="space-y-4">
              <Field label="Email" htmlFor="email" hint="They get a link valid for 7 days.">
                <Input
                  id="email"
                  name="email"
                  type="email"
                  required
                  placeholder="teammate@example.com"
                />
              </Field>
              <Field label="Role" htmlFor="role">
                <SelectField
                  id="role"
                  value={inviteRole}
                  onValueChange={setInviteRole}
                  options={roleOptions(assignable.filter((r) => r !== "owner"))}
                />
              </Field>
              <Button type="submit" className="w-full" loading={isPending("invite")}>
                Send invitation
              </Button>
            </form>
          </Panel>
        </Can>
      </div>
    </>
  );
}
