import * as React from "react";
import { cn } from "@/lib/utils";

interface AppInputProps extends React.ComponentProps<"input"> {
  className?: string;
}

function AppInput({ className, ...props }: AppInputProps) {
  return (
    <input
      className={cn(
        "h-7 rounded-md border border-app-border-input bg-app-surface-alt px-2.5",
        "text-app-body text-app-text placeholder:text-app-text-muted",
        "outline-none focus:border-app-text-secondary transition-colors",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        className
      )}
      {...props}
    />
  );
}

export { AppInput };
