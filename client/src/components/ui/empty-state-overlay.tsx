import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

/** Absolute overlay preserves the underlying widget and fades its unavailable data. */
export function EmptyStateOverlay({ className }: { className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-app-bg/65", className)}>
      <span className="rounded-sm bg-app-surface px-3 py-1.5 text-app-detail font-medium text-app-text">{m.home_insights_no_data()}</span>
    </div>
  );
}
