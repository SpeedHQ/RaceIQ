import * as React from "react";
import { cn } from "@/lib/utils";

interface AppInputProps extends React.ComponentProps<"input"> {
  className?: string;
}

function AppInput({ className, ...props }: AppInputProps) {
  return (
    <input
      className={cn(
        "rounded border border-app-border-input bg-app-surface-alt px-2 py-1.5",
        "text-sm text-app-text placeholder:text-app-text-dim",
        "outline-none focus:ring-1 focus:ring-app-border-input",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  );
}

export { AppInput };
