"use client";

import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@upzy/ui/components/dropdown-menu";
import { buttonVariants } from "@upzy/ui/lib/button-variants";
import { cn } from "@upzy/ui/lib/utils";

export interface MenuAction {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Draws a divider above this item. */
  separated?: boolean;
}

/** The "…" menu on a row. `label` names the row for screen readers, e.g. "Actions for api.example.com". */
export function ActionMenu({
  label,
  actions,
  className,
}: {
  label: string;
  actions: MenuAction[];
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), className)}
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        {actions.map((a) => (
          <div key={a.label}>
            {a.separated && <DropdownMenuSeparator />}
            <DropdownMenuItem
              variant={a.destructive ? "destructive" : "default"}
              disabled={a.disabled}
              onClick={a.onSelect}
            >
              {a.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
