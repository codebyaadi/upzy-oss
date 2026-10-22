import { buttonVariants } from "@upzy/ui/lib/button-variants";
import { cn } from "@upzy/ui/lib/utils";
import Link from "next/link";

type Props = Omit<React.ComponentProps<typeof Link>, "className"> &
  Pick<NonNullable<Parameters<typeof buttonVariants>[0]>, "variant" | "size"> & {
    className?: string;
  };

/**
 * A real link styled as a button. Base UI's Button forces role="button" on whatever it renders,
 * which would make screen readers announce navigation as buttons.
 */
export function ButtonLink({ variant, size, className, ...props }: Props) {
  return <Link className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
