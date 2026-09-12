import { useEffect, useMemo, useRef } from "react";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import { Button } from "../../ui/button";

interface IssuesListProps {
  issues: TuneIssue[];
  onIssueClick: (distanceFrac: number) => void;
  onIssueHover: (issue: TuneIssue | null) => void;
  highlightedIssueKey?: string | null;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--status-danger)",
  warn: "var(--status-warning)",
  info: "var(--status-info)",
};

/** Issues grouped by corner (falling back to "General" for lap-wide ones). */
export function IssuesList({ issues, onIssueClick, onIssueHover, highlightedIssueKey }: IssuesListProps) {
  const highlightedRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = highlightedRef.current;
    const container = listRef.current?.parentElement;
    if (!row || !container) return;
    const rowRect = row.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const maxScroll = container.scrollHeight - container.clientHeight;
    container.scrollTop = Math.max(0, Math.min(maxScroll, container.scrollTop + (rowRect.top + rowRect.height / 2) - (containerRect.top + containerRect.height / 2)));
  }, [highlightedIssueKey]);
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
    <div ref={listRef} className="space-y-3">
      {groups.map(([corner, items]) => (
        <div key={corner}>
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">{corner}</div>
          <ul className="space-y-1">
            {items.map((it) => {
              const clickable = it.distanceFrac != null;
              const issueKey = `${it.kind}-${corner}-${it.detail}`;
              return (
                <li key={issueKey}>
                  <Button
                    variant="app-ghost"
                    size="app-sm"
                    disabled={!clickable}
                    ref={highlightedIssueKey === issueKey ? highlightedRef : undefined}
                    onClick={() => it.distanceFrac != null && onIssueClick(it.distanceFrac)}
                    onMouseEnter={() => clickable && onIssueHover(it)}
                    onMouseLeave={() => onIssueHover(null)}
                    onFocus={() => clickable && onIssueHover(it)}
                    onBlur={() => onIssueHover(null)}
                    className={`!w-full !justify-start !px-1.5 !py-1 flex items-start gap-2 text-left text-sm ${clickable ? "hover:bg-app-surface-hover cursor-pointer" : "cursor-default"} ${highlightedIssueKey === issueKey ? "bg-app-accent/15 ring-1 ring-app-accent/50" : ""}`}
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
