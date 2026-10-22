import { Loading03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@upzy/ui/lib/utils";

/** Decorative by default; pass `role="status"` and an `aria-label` where it is the only sign of loading. */
function Spinner({ className, ...props }: Omit<React.ComponentProps<"svg">, "strokeWidth">) {
  return (
    <HugeiconsIcon
      icon={Loading03Icon}
      strokeWidth={2}
      data-slot="spinner"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
