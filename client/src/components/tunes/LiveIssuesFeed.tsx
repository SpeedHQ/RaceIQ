import { isEligibilityUsable } from "@shared/racing/quality/policies";
import { localizedEligibilityDecisionText } from "@/components/LapQualityBadge";
import type { TuneIssue } from "../../../../shared/racing/tuning/issues";
import { useTelemetryStore } from "../../stores/telemetry";

const SEVERITY_DOT: Record<TuneIssue["severity"], string> = {
  critical: "bg-status-danger",
  warn: "bg-status-warning",
  info: "bg-status-info",
};

export function buildLiveIssueFeedPresentation(feed: ReturnType<typeof useTelemetryStore.getState>["lapIssuesFeed"]) {
  const rows = feed.flatMap((entry) => entry.issues.map((issue) => ({ lapNumber: entry.lapNumber, issue })));
  const blocked = feed
    .filter((entry) => !isEligibilityUsable(entry.eligibility))
    .map((entry) => ({ lapId: entry.lapId, lapNumber: entry.lapNumber, text: localizedEligibilityDecisionText(entry.eligibility) }));
  return { rows, blocked, showNoIssues: rows.length === 0 && blocked.length === 0 };
}

/**
 * LiveIssuesFeed — display-only feed of deterministic tune issues detected as
 * laps complete during a live test. Reads the WS-pushed `lapIssuesFeed` store
 * (most recent lap first) and flattens it into a scannable table. No analysis
 * runs client-side; this only renders what the server pushed.
 */
export function LiveIssuesFeed() {
  const feed = useTelemetryStore((s) => s.lapIssuesFeed);

  const { rows, blocked, showNoIssues } = buildLiveIssueFeedPresentation(feed);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-3 py-2 border-b border-app-border">
        <h2 className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Issues Detected</h2>
      </div>
      {blocked.length > 0 && (
        <ul className="shrink-0 divide-y divide-app-border/50 border-b border-app-border bg-status-warning/5">
          {blocked.slice(0, 3).map((entry) => (
            <li key={entry.lapId} className="px-3 py-1.5 text-xs text-status-warning">
              L{entry.lapNumber} · {entry.text}
            </li>
          ))}
        </ul>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {rows.length === 0 ? (
          showNoIssues ? (
            <div className="p-3 text-xs text-app-text-dim">No issues detected yet this test.</div>
          ) : null
        ) : (
          <ul className="divide-y divide-app-border/50">
            {rows.map(({ lapNumber, issue }) => (
              <li key={`${lapNumber}-${issue.kind}-${issue.corner ?? "lap"}-${issue.distanceFrac ?? "global"}-${issue.detail}`} className="flex items-start gap-2 px-3 py-1.5">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${SEVERITY_DOT[issue.severity]}`} />
                <span className="shrink-0 text-app-caption font-mono text-app-text-muted tabular-nums w-8">L{lapNumber}</span>
                {issue.corner && <span className="shrink-0 text-app-caption font-mono text-app-text-secondary w-8">{issue.corner}</span>}
                <span className="text-xs text-app-text leading-snug">{issue.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
