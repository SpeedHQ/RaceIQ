import type * as React from "react";
import { cn } from "@/lib/utils";

interface AppInputProps extends React.ComponentProps<"input"> {
  className?: string;
}

function AppInput({ className, type, ...props }: AppInputProps) {
  return (
    <input
      type={type}
      className={cn(
        "rounded border border-app-border-input px-2 py-1.5",
        type === "search" ? "bg-transparent" : "bg-app-surface-alt",
        "text-app-subtext text-app-text placeholder:text-app-text-dim",
        "outline-none focus:border-app-accent focus:ring-0 focus:ring-app-accent",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}

export { AppInput };
