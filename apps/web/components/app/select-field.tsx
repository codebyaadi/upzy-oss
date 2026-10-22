"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@upzy/ui/components/select";
import { cn } from "@upzy/ui/lib/utils";

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

/** A labelled single-choice picker on top of the shadcn Select. */
export function SelectField<T extends string>({
  value,
  onValueChange,
  options,
  id,
  name,
  "aria-label": ariaLabel,
  placeholder,
  className,
  disabled,
  size,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: Option<T>[];
  id?: string;
  name?: string;
  "aria-label"?: string;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  size?: "sm" | "default";
}) {
  return (
    <Select<T>
      value={value}
      onValueChange={(v) => v !== null && onValueChange(v)}
      items={options}
      name={name}
      disabled={disabled}
    >
      <SelectTrigger id={id} aria-label={ariaLabel} size={size} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
