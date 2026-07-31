import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex max-w-full items-center justify-center rounded-full border font-medium leading-tight break-words",
  {
    variants: {
      variant: {
        neutral: "border-app-border bg-app-surface-alt text-app-text-muted",
        info: "border-status-info/30 bg-status-info/15 text-status-info",
        success: "border-status-success/30 bg-status-success/15 text-status-success",
        warning: "border-status-warning/30 bg-status-warning/15 text-status-warning",
        danger: "border-status-danger/30 bg-status-danger/15 text-status-danger",
      },
      size: {
        compact: "px-1.5 py-0.5 text-app-micro",
        default: "px-2 py-0.5 text-app-caption",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "default",
    },
  },
);

type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

function Badge({ className, variant, size, ...props }: BadgeProps) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant, size, className }))} {...props} />;
}

export { Badge, badgeVariants };
export type { BadgeProps };
