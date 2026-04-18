import type { ReactNode } from "react";

interface DashShellProps {
  children: ReactNode;
  className?: string;
}

export function DashShell({ children, className = "" }: DashShellProps) {
  return (
    <div
      className={`fixed inset-0 bg-black text-white overflow-hidden select-none ${className}`}
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        WebkitTapHighlightColor: "transparent",
        WebkitTouchCallout: "none",
        overscrollBehavior: "none",
        touchAction: "none",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </div>
  );
}
