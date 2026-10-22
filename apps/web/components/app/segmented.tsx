"use client";

import { Tabs, TabsList, TabsTrigger } from "@upzy/ui/components/tabs";

/** A compact single-choice toggle (time range, status filter) built on shadcn Tabs: arrow keys move between options. */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  label,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <Tabs value={value} onValueChange={(v) => onValueChange(v as T)}>
      <TabsList aria-label={label}>
        {options.map((o) => (
          <TabsTrigger key={o.value} value={o.value} className="px-4">
            {o.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
