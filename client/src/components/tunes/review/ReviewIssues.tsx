import type { TuneIssue } from "@shared/racing/tuning/issues";
import { Button } from "@/components/ui/button";

const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-status-danger border-status-danger/60 bg-status-danger/10",
  warn: "text-status-warning border-status-warning/60 bg-status-warning/10",
  info: "text-status-info border-status-info/60 bg-status-info/10",
};

export function IssuePill({ issue, onHover }: { issue: TuneIssue; onHover?: (frac: number | null) => void }) {
  const locatable = issue.distanceFrac != null && !!onHover;
  if (!locatable) {
    return (
      <div className={`text-xs px-2 py-1 rounded border ${SEVERITY_CLASS[issue.severity]}`}>
        <span className="font-mono uppercase mr-1.5 opacity-70">{issue.kind}</span>
        {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
        {issue.detail}
      </div>
    );
  }
  return (
    <Button
      variant="app-ghost"
      size="app-sm"
      onMouseEnter={() => onHover!(issue.distanceFrac!)}
      onMouseLeave={() => onHover!(null)}
      onFocus={() => onHover!(issue.distanceFrac!)}
      onBlur={() => onHover!(null)}
      className={`!justify-start !border !py-1 text-left text-xs ${SEVERITY_CLASS[issue.severity]} cursor-pointer`}
    >
      <span className="font-mono uppercase mr-1.5 opacity-70">{issue.kind}</span>
      {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
      {issue.detail}
    </Button>
  );
}
