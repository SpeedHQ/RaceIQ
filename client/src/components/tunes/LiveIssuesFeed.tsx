import type { TuneIssue } from "@shared/types";
import { useTelemetryStore } from "../../stores/telemetry";

const SEVERITY_DOT: Record<TuneIssue["severity"], string> = {
  critical: "bg-status-danger",
  warn: "bg-status-warning",
  info: "bg-status-info",
};

/**
 * LiveIssuesFeed — display-only feed of deterministic tune issues detected as
 * laps complete during a live test. Reads the WS-pushed `lapIssuesFeed` store
 * (most recent lap first) and flattens it into a scannable table. No analysis
 * runs client-side; this only renders what the server pushed.
 */
export function LiveIssuesFeed() {
  const feed = useTelemetryStore((s) => s.lapIssuesFeed);

  const rows = feed.flatMap((entry) => entry.issues.map((issue) => ({ lapNumber: entry.lapNumber, issue })));

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-2 border-b border-app-border">
        <h2 className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider">Issues Detected</h2>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-3 text-xs text-app-text-dim">No issues detected yet this test.</div>
        ) : (
          <ul className="divide-y divide-app-border/50">
            {rows.map(({ lapNumber, issue }, i) => (
              <li key={`${lapNumber}-${issue.kind}-${issue.corner ?? ""}-${i}`} className="flex items-start gap-2 px-3 py-1.5">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${SEVERITY_DOT[issue.severity]}`} />
                <span className="shrink-0 text-[10px] font-mono text-app-text-muted tabular-nums w-8">L{lapNumber}</span>
                {issue.corner && <span className="shrink-0 text-[10px] font-mono text-app-text-secondary w-8">{issue.corner}</span>}
                <span className="text-xs text-app-text leading-snug">{issue.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
