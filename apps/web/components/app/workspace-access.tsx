"use client";

import { Checkbox } from "@upzy/ui/components/checkbox";
import { Switch } from "@upzy/ui/components/switch";

export interface AccessDraft {
  /** false: sees every workspace. */
  limited: boolean;
  workspaceIds: string[];
}

/** Chooses which workspaces a viewer or member may see. Admins and owners always see all of them. */
export function WorkspaceAccess({
  workspaces,
  value,
  onChange,
  idPrefix,
}: {
  workspaces: { id: string; name: string }[];
  value: AccessDraft;
  onChange: (next: AccessDraft) => void;
  idPrefix: string;
}) {
  const toggle = (id: string, on: boolean) =>
    onChange({
      ...value,
      workspaceIds: on
        ? [...new Set([...value.workspaceIds, id])]
        : value.workspaceIds.filter((w) => w !== id),
    });

  return (
    <div className="space-y-3">
      <label className="flex items-start justify-between gap-4 text-sm">
        <span>
          <span className="font-semibold">Limit to some workspaces</span>
          <span className="text-muted-foreground block text-xs">
            For a client or contractor: they see only the workspaces you tick, nothing of the
            others.
          </span>
        </span>
        <Switch
          aria-label="Limit to some workspaces"
          checked={value.limited}
          onCheckedChange={(limited) => onChange({ ...value, limited })}
        />
      </label>
      {value.limited && (
        <fieldset className="max-h-48 space-y-2 overflow-y-auto rounded-2xl border p-3">
          <legend className="sr-only">Workspaces they can see</legend>
          {workspaces.map((w) => (
            <label
              key={w.id}
              htmlFor={`${idPrefix}-${w.id}`}
              className="flex items-center gap-3 text-sm"
            >
              <Checkbox
                id={`${idPrefix}-${w.id}`}
                checked={value.workspaceIds.includes(w.id)}
                onCheckedChange={(on) => toggle(w.id, on === true)}
              />
              <span className="truncate">{w.name}</span>
            </label>
          ))}
          {value.workspaceIds.length === 0 && (
            <p className="text-muted-foreground text-xs">
              With none ticked they see nothing until you add one.
            </p>
          )}
        </fieldset>
      )}
    </div>
  );
}
