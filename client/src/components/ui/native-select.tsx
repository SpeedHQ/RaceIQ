import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Native keyboard and mobile selection with the shared cockpit field styling. */
export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <select className={cn(
    "w-full min-w-0 rounded border border-app-border-input bg-app-surface-alt px-2 py-1.5 text-app-detail text-app-text outline-none transition-colors focus:border-app-accent disabled:cursor-not-allowed disabled:opacity-50",
    className,
  )} {...props} />;
}
