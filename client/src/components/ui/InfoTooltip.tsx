import { Info } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Small info icon that shows a tooltip on hover.
 * Wrap in a flex container alongside a label for best alignment.
 */
export function InfoTooltip({
  children,
  position = "top",
  width = "max",
}: {
  children: ReactNode;
  /** Whether tooltip pops above or below the icon */
  position?: "top" | "bottom";
  /** Tailwind max-w class token or "max" for w-max */
  width?: "max" | "xs" | "sm" | "md";
}) {
  const posClass = position === "top" ? "bottom-full mb-2" : "top-full mt-2";
  const widthClass =
    width === "max" ? "w-max max-w-[240px]" :
    width === "xs"  ? "w-[180px]" :
    width === "sm"  ? "w-[220px]" :
                      "w-[280px]";
  return (
    <span className="group/tip relative inline-flex items-center shrink-0">
      <Info className="w-3 h-3 text-app-text-dim cursor-help" />
      <span
        className={`absolute left-0 ${posClass} ${widthClass} hidden group-hover/tip:block bg-app-surface-alt border border-app-border-input rounded px-2 py-1.5 text-[10px] text-app-text-secondary z-50 pointer-events-none normal-case tracking-normal leading-relaxed`}
      >
        {children}
      </span>
    </span>
  );
}
