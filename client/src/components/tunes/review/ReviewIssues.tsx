import type { TuneIssue } from "@shared/racing/tuning/issues";
import { Button } from "@/components/ui/button";

const SEVERITY_COLOR: Record<TuneIssue["severity"], string> = {
  critical: "var(--status-danger)",
  warn: "var(--status-warning)",
  info: "var(--status-info)",
};

export function IssuePill({ issue, onHover }: { issue: TuneIssue; onHover?: (frac: number | null) => void }) {
  const locatable = issue.distanceFrac != null && !!onHover;
  const content = (
    <>
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[issue.severity] ?? SEVERITY_COLOR.info }} />
      <span className="text-app-text">{issue.detail}</span>
    </>
  );
  if (!locatable) return <div className="flex items-start gap-2 px-1.5 py-1 text-left text-sm">{content}</div>;
  return (
    <Button
      variant="app-ghost"
      size="app-sm"
      onMouseEnter={() => onHover(issue.distanceFrac!)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(issue.distanceFrac!)}
      onBlur={() => onHover(null)}
      className="!w-full !justify-start !px-1.5 !py-1 flex items-start gap-2 text-left text-sm hover:bg-app-surface-hover cursor-pointer"
    >
      {content}
    </Button>
  );
}
