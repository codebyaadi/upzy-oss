"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { buttonVariants } from "@upzy/ui/lib/button-variants";
import { cn } from "@upzy/ui/lib/utils";
import type { VariantProps } from "class-variance-authority";

import { Spinner } from "./spinner";

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Shows a spinner and blocks clicks while an action is in flight. Keeps focus and width stable. */
    loading?: boolean;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      // `focusableWhenDisabled` keeps the button in the tab order while loading, so focus is not lost.
      focusableWhenDisabled={loading}
      disabled={disabled || loading}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    >
      {loading && <Spinner aria-hidden />}
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
