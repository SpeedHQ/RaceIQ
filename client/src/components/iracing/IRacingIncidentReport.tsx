import { Link } from "@tanstack/react-router";
import { useIRacingIncidentReport } from "@/hooks/session-queries";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { formatIncidentTime, incidentEventLabel, incidentEvidenceLabel } from "./incident-format";

export function IRacingIncidentReport({ sessionId }: { sessionId: number }) {
  const query = useIRacingIncidentReport(sessionId);
  const report = query.data;
  return (
    <section aria-labelledby="iracing-incident-report-heading" className="m-3 min-w-0 rounded-lg border border-app-border bg-app-surface p-4 sm:m-4">
      <h2 id="iracing-incident-report-heading" className="text-lg font-semibold text-app-text">{m.iracing_incident_report_heading()}</h2>
      {query.isLoading ? <p role="status" className="mt-3 text-sm text-app-text-muted">{m.iracing_incident_report_loading()}</p> : query.isError ? (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-status-danger">{m.iracing_incident_report_error()}</p>
          <Button variant="app-outline" size="app-sm" onClick={() => void query.refetch()}>{m.iracing_incident_report_retry()}</Button>
        </div>
      ) : report ? <>
        <dl className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            [m.iracing_incident_report_points(), report.observedIncidentPoints === null ? "—" : String(report.observedIncidentPoints)],
            [m.iracing_incident_report_spans(), report.offTrackSpans === null ? "—" : String(report.offTrackSpans)],
            [m.iracing_incident_report_duration(), formatIncidentTime(report.observedOffTrackSeconds)],
            [m.iracing_incident_report_streak(), report.longestCleanLapStreak === null ? "—" : String(report.longestCleanLapStreak)],
          ].map(([label, value]) => <div key={label} className="min-w-0 rounded-md border border-app-border bg-app-surface-alt p-3">
            <dt className="text-xs text-app-text-muted">{label}</dt>
            <dd className="mt-1 break-words font-mono text-2xl font-semibold tabular-nums text-app-text">{value}</dd>
          </div>)}
        </dl>
        <div className="space-y-1 text-sm text-app-text-secondary">
          <p>{m.iracing_incident_report_windows({ included: report.coverage.lapsWithCapture, total: report.coverage.totalLaps })}</p>
          <p>{m.iracing_incident_report_counter({ status: incidentEvidenceLabel(report.coverage.incidentStatus) })} · {m.iracing_incident_report_surface({ status: incidentEvidenceLabel(report.coverage.surfaceStatus) })}</p>
          <p>{m.iracing_incident_report_scope()}</p>
          <p className="text-xs text-app-text-muted">{m.iracing_incident_report_explanation()}</p>
        </div>
        {report.coverage.incidentStatus === "unavailable" && report.coverage.surfaceStatus === "unavailable" ? <p className="mt-4 text-sm text-app-text-muted">{m.iracing_incident_report_no_evidence()}</p> : report.events.length === 0 ? <p className="mt-4 text-sm text-app-text-muted">{m.iracing_incident_report_empty()}</p> : null}
        {report.events.length > 0 && <ol aria-label={m.iracing_incident_report_events()} className="mt-4 max-h-80 overflow-y-auto divide-y divide-app-border">
          {report.events.map(event => <li key={event.id} className="flex min-w-0 flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 break-words">
              <p className="font-medium text-app-text">{incidentEventLabel(event)}</p>
              <p className="font-mono text-xs tabular-nums text-app-text-secondary">{m.iracing_incident_report_lap_time({ lap: event.lapNumber, time: formatIncidentTime(event.sessionTimeSec) })}</p>
              {event.kind === "incident-points" && <p className="text-xs text-app-text-muted">{m.iracing_incident_report_bounds({ previous: formatIncidentTime(event.previousSessionTimeSec), current: formatIncidentTime(event.sessionTimeSec) })}</p>}
            </div>
            {event.replay !== null ? <Link to="/$gameid/sessions/$sessionId/replay/$lapId" params={{ gameid: "iracing", sessionId: String(sessionId), lapId: String(event.lapId) }} search={{ cursor: event.replay.frameIndex, viz: undefined, ai: undefined, view: undefined }} className="shrink-0 self-start rounded px-2 py-1 text-app-accent hover:underline focus-visible:outline-2 focus-visible:outline-app-accent sm:self-auto">
              {event.replay.lapTimeSec === null ? m.iracing_incident_report_replay_link() : m.iracing_incident_report_replay({ time: formatIncidentTime(event.replay.lapTimeSec) })}
            </Link> : <span className="text-xs text-app-text-muted">{m.iracing_incident_report_no_replay()}</span>}
          </li>)}
        </ol>}
      </> : null}
    </section>
  );
}
