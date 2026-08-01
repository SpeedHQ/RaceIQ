import type { HTMLAttributes } from "react";
import { cn } from "../lib/utils";

/**
 * Shared responsive boundary for dense RaceIQ workspaces.
 *
 * Descendants use named Tailwind container variants so composition follows
 * available content width after the app sidebar, not outer window dimensions.
 */
export function ResponsiveWorkspace({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div data-responsive-workspace className={cn("@container/workspace h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto", className)} {...props} />;
}
