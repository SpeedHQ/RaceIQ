import { ChevronDown, ChevronUp } from "lucide-react";
import type { ReactNode } from "react";

interface PanelSectionHeaderProps {
  title: string;
  collapsed?: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}

export function PanelSectionHeader({ title, collapsed, onToggle, children }: PanelSectionHeaderProps) {
  const collapsible = onToggle !== undefined;

  return (
    <div className="flex w-full items-center justify-between">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{title}</span>
      <div className="flex items-center gap-3">
        {collapsible && (
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-[10px] text-app-text-muted hover:text-app-text"
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
          >
            {collapsed ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
            {collapsed ? "Expand" : "Collapse"}
          </button>
        )}
        {children}
      </div>
    </div>
  );
}
