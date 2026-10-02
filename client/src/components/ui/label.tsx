import type * as React from "react";

import { cn } from "@/lib/utils";

function Label({ className, htmlFor, children, ...props }: React.ComponentProps<"label">) {
  const classes = cn(
    "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
    className,
  );

  if (!htmlFor) {
    return (
      <span data-slot="label" className={classes} {...props}>
        {children}
      </span>
    );
  }

  return (
    <label htmlFor={htmlFor} data-slot="label" className={classes} {...props}>
      {children}
    </label>
  );
}

export { Label };
