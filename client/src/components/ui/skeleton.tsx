import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SkeletonProps {
  children?: ReactNode;
  className?: string;
  loading?: boolean;
  shape?: "line" | "circle" | "chart";
}

/** Keep the real content's footprint while masking it during loading. */
export function Skeleton({ children, className, loading = true, shape = "line" }: SkeletonProps) {
  const Element = shape === "line" ? "span" : "div";
  return (
    <Element
      aria-busy={loading || undefined}
      className={cn(
        shape === "line" ? "inline-block min-w-[3ch] align-baseline" : "relative block",
        loading && "animate-pulse bg-app-progress-track text-transparent motion-reduce:animate-none",
        loading && (shape === "circle" ? "rounded-full" : "rounded-sm"),
        className,
      )}
    >
      <Element className={cn(shape !== "line" && "relative block h-full w-full", loading && "invisible")} aria-hidden={loading || undefined}>{children ?? "—"}</Element>
    </Element>
  );
}
