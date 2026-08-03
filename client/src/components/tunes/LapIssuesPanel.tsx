import type { LapMeta } from "../../../../shared/racing/sessions/types";
import type { TuneIssue } from "../../../../shared/racing/tuning/issues";
import { useLapIssues } from "../../hooks/queries";

const SEVERITY_CLASS: Record<TuneIssue["severity"], string> = {
  critical: "text-status-danger border-status-danger/30 bg-status-danger/10",
  warn: "text-status-warning border-status-warning/30 bg-status-warning/10",
  info: "text-status-info border-status-info/30 bg-status-info/10",
};

/**
 * LapIssuesPanel — review-mode issue feed (Phase 2). Fetches the deterministic
 * per-lap issue list for a past session's laps on demand (no live analysis
 * running), most recent lap first, bounded to keep the panel scannable.
 */
export function LapIssuesPanel({ laps }: { laps: LapMeta[] }) {
  const recent = [...laps]
    .filter((l) => l.isValid)
    .sort((a, b) => b.lapNumber - a.lapNumber)
    .slice(0, 5);

  if (recent.length === 0) {
    return <div className="p-3 text-xs text-app-text-dim">No valid laps in this session yet.</div>;
  }

  return (
    <div className="p-3 space-y-2">
      <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Issue Feed</h2>
      {recent.map((lap) => (
        <LapIssuesEntry key={lap.id} lap={lap} />
      ))}
    </div>
  );
}

function LapIssuesEntry({ lap }: { lap: LapMeta }) {
  const { data: issues, isLoading } = useLapIssues(lap.id);

  return (
    <div className="border border-app-border rounded p-2">
      <div className="text-app-compact text-app-text-muted uppercase tracking-wider mb-1">
        Lap {lap.lapNumber} — {lap.lapTime.toFixed(3)}s
      </div>
      {isLoading ? (
        <div className="text-xs text-app-text-dim">Loading…</div>
      ) : !issues || issues.length === 0 ? (
        <div className="text-xs text-app-text-dim">No issues (or no stored telemetry for this lap).</div>
      ) : (
        <ul className="space-y-1">
          {issues.map((issue) => (
            <li key={`${issue.kind}-${issue.corner ?? "lap"}-${issue.distanceFrac ?? "global"}-${issue.detail}`} className={`text-xs px-1.5 py-0.5 rounded border ${SEVERITY_CLASS[issue.severity]}`}>
              {issue.corner ? <span className="font-mono mr-1">{issue.corner}</span> : null}
              {issue.detail}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
