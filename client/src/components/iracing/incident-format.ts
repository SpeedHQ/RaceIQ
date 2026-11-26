import type { IRacingEvidenceStatus, IRacingIncidentEvent } from "@raceiq/shared/racing/sessions/iracing-incidents";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";

/** Simulator zero is a real time, not the lap formatter's missing-time sentinel. */
export function formatIncidentTime(seconds: number | null): string {
  return seconds === null ? "—" : seconds === 0 ? "0:00.000" : formatLapTime(seconds);
}
export function incidentEvidenceLabel(status: IRacingEvidenceStatus): string {
  return status === "available" ? m.iracing_incident_report_available() : status === "partial" ? m.iracing_incident_report_partial() : m.iracing_incident_report_unavailable();
}
export function incidentEventLabel(event: IRacingIncidentEvent): string {
  if (event.kind === "incident-points") return m.iracing_incident_report_point_event({ points: event.points });
  return [m.iracing_incident_report_span_event(), m.iracing_incident_report_sampled_duration({ duration: formatIncidentTime(event.observedSeconds) }), !event.startObserved ? m.iracing_incident_report_clipped_start() : null, !event.endObserved ? m.iracing_incident_report_clipped_end() : null].filter(Boolean).join(" · ");
}
