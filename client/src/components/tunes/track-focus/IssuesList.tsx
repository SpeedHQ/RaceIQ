import type { TuneIssue } from "@shared/types";
import { useMemo } from "react";
import { Button } from "../../ui/button";

interface IssuesListProps {
  issues: TuneIssue[];
  onIssueClick: (distanceFrac: number) => void;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--status-danger)",
  warn: "var(--status-warning)",
  info: "var(--status-info)",
};

/** Issues grouped by corner (falling back to "General" for lap-wide ones). */
export function IssuesList({ issues, onIssueClick }: IssuesListProps) {
  const groups = useMemo(() => {
    const map = new Map<string, TuneIssue[]>();
    for (const it of issues) {
      const key = it.corner ?? "General";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(it);
    }
    return Array.from(map.entries()).sort(([a], [b]) => {
      if (a === "General") return -1;
      if (b === "General") return 1;
      return 0;
    });
  }, [issues]);

  if (issues.length === 0) {
    return <div className="text-app-text-dim text-sm">No issues detected for this stint.</div>;
  }

  return (
    <div className="space-y-3">
      {groups.map(([corner, items]) => (
        <div key={corner}>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">{corner}</div>
          <ul className="space-y-1">
            {items.map((it) => {
              const clickable = it.distanceFrac != null;
              return (
                <li key={`${it.kind}-${corner}-${it.detail}`}>
                  <Button
                    type="button"
                    variant="app-ghost"
                    size="app-sm"
                    disabled={!clickable}
                    onClick={() => it.distanceFrac != null && onIssueClick(it.distanceFrac)}
                    className={`!h-auto !w-full !justify-start !rounded !px-1.5 !py-1 flex items-start gap-2 text-left text-sm ${clickable ? "hover:bg-app-surface-hover cursor-pointer" : "cursor-default"}`}
                  >
                    <span className="mt-1.5 w-2 h-2 rounded-full shrink-0" style={{ background: SEV_COLOR[it.severity] ?? SEV_COLOR.info }} />
                    <span className="text-app-text">{it.detail}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
