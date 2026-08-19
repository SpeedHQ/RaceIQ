import type { RaceEvent, RaceEventPage, RaceEventType } from "@shared/racing/events/contracts";

import { useSessionRaceEvents } from "@/hooks/session-queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export const RACE_EVENT_LABELS: Record<RaceEventType, string> = {
  session_started: "Session started",
  session_ended: "Session ended",
  session_phase_changed: "Session phase changed",
  green_flag: "Green flag",
  caution_started: "Caution started",
  caution_ended: "Caution ended",
  red_flag_started: "Red flag started",
  checkered_flag: "Checkered flag",
  restart_started: "Restart started",
  timebase_reset: "Timebase reset",
  participant_joined: "Participant joined",
  participant_became_unavailable: "Participant became unavailable",
  participant_returned: "Participant returned",
  driver_started_stint: "Driver started stint",
  driver_changed: "Driver changed",
  position_changed: "Position changed",
  lap_started: "Lap started",
  lap_completed: "Lap completed",
  sector_completed: "Sector completed",
  track_limit_or_lap_invalidated: "Track limit or lap invalidation observed",
  pit_entry: "Entered pit road",
  pit_stall_arrival: "Arrived at pit stall",
  pit_service_started: "Pit service started",
  tire_service_observed: "Tire service observed",
  fuel_service_observed: "Fuel service observed",
  repair_service_observed: "Repair service observed",
  driver_service_observed: "Driver service observed",
  pit_service_completed: "Pit service completed",
  pit_stall_departure: "Departed pit stall",
  pit_exit: "Exited pit road",
  pit_visit_incomplete: "Pit visit incomplete",
  drive_through_observed: "Drive-through observed",
  incident_observed: "Incident observed",
  damage_warning_started: "Damage warning started",
  damage_warning_cleared: "Damage warning cleared",
  penalty_issued: "Penalty issued",
  penalty_cleared: "Penalty cleared",
  car_reset: "Car reset",
  fast_repair_used: "Fast repair used",
  retirement_observed: "Retirement observed",
  source_connected: "Telemetry source connected",
  source_disconnected: "Telemetry source disconnected",
  source_stale: "Telemetry source stale",
  source_recovered: "Telemetry source recovered",
  telemetry_gap: "Telemetry gap",
  out_of_order_input: "Out-of-order input",
  duplicate_input_suppressed: "Duplicate input suppressed",
  storage_drop: "Storage drop",
  storage_failure: "Storage failure",
  timeline_discontinuity: "Timeline discontinuity",
};

const PAYLOAD_FIELD_LABELS: Record<string, string> = {
  phase: "Phase",
  previousPhase: "Previous phase",
  reason: "Reason",
  terminalObserved: "Terminal state observed",
  gridStart: "Grid start",
  nativeCode: "Native code",
  kind: "Caution kind",
  previousSourceTimeMs: "Previous source time",
  currentSourceTimeMs: "Current source time",
  sourceId: "Source participant ID",
  identityState: "Identity state",
  displayName: "Display name",
  vehicleId: "Vehicle ID",
  previousDriverId: "Previous driver ID",
  driverId: "Driver ID",
  previousDisplayName: "Previous driver",
  previousPosition: "Previous position",
  position: "Position",
  lapNumber: "Lap",
  lapTimeMs: "Lap time",
  isValid: "Valid lap",
  conditions: "Conditions",
  sectorIndex: "Sector index",
  sectorTimeMs: "Sector time",
  previousState: "Previous pit state",
  state: "Pit state",
  trigger: "Service trigger",
  changedCorners: "Changed corners",
  previousCompound: "Previous compound",
  currentCompound: "Current compound",
  beforeWear: "Wear before service",
  afterWear: "Wear after service",
  beforeLitres: "Fuel before service",
  afterLitres: "Fuel after service",
  addedLitres: "Fuel added",
  previousComponents: "Components before",
  currentComponents: "Components after",
  repairedComponents: "Repaired components",
  durationMs: "Duration",
  observedActions: "Observed actions",
  previousCount: "Previous incident count",
  currentCount: "Incident count",
  delta: "Incident increase",
  changedComponents: "Changed components",
  previousValue: "Previous value",
  currentValue: "Current value",
  resolution: "Resolution",
  status: "Status",
  lifecycleKind: "Lifecycle state",
  details: "Details",
  missingCount: "Missing observations",
  countMethod: "Count method",
  sourceSequenceFamily: "Native sequence family",
  previousSequence: "Previous native sequence",
  currentSequence: "Current native sequence",
  operation: "Storage operation",
};

const EVIDENCE_BADGES = {
  observed: { label: "Observed", variant: "success" },
  derived: { label: "Derived", variant: "info" },
  inferred: { label: "Inferred", variant: "warning" },
} as const;

const QUALITY_BADGES = {
  degraded: { label: "Degraded", variant: "warning" },
  ambiguous: { label: "Ambiguous", variant: "warning" },
  unavailable: { label: "Unavailable", variant: "danger" },
} as const;

function formatNumber(value: number): string {
  return value.toFixed(3).replace(/\.?0+$/, "");
}

function formatMilliseconds(value: number): string {
  return `${formatNumber(value / 1_000)} s`;
}

function formatEnum(value: string): string {
  return value.replaceAll("-", " ");
}

function formatCornerValues(value: Record<string, unknown>, normalized: boolean): string {
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([key, amount]) => `${key.toUpperCase()} ${formatNumber(normalized ? amount * 100 : amount)}%`)
    .join(", ");
}

function formatPayloadValue(key: string, value: unknown): string | null {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => (typeof item === "string" ? formatEnum(item) : String(item))).join(", ");
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key.endsWith("Ms")) return formatMilliseconds(value);
    if (key.endsWith("Litres")) return `${formatNumber(value)} L`;
    return formatNumber(value);
  }
  if (typeof value === "string") return key.endsWith("Id") ? value : formatEnum(value);
  if (typeof value === "object") {
    const values = value as Record<string, unknown>;
    if (key.endsWith("Wear")) return formatCornerValues(values, true);
    if (key.endsWith("Components")) return formatCornerValues(values, false);
    return JSON.stringify(value);
  }
  return String(value);
}

export function formatRaceEventDetails(event: RaceEvent): string[] {
  return Object.entries(event.payload as Record<string, unknown>).flatMap(([key, value]) => {
    const formatted = formatPayloadValue(key, value);
    return formatted == null ? [] : [`${PAYLOAD_FIELD_LABELS[key] ?? key}: ${formatted}`];
  });
}

export function flattenRaceEventPages(pages: readonly RaceEventPage[]): RaceEvent[] {
  return pages
    .flatMap((page) => page.items)
    .sort((left, right) => left.timelineEpoch - right.timelineEpoch || left.sequence - right.sequence || left.eventOrder - right.eventOrder || left.eventId.localeCompare(right.eventId));
}

export function raceEventBadges(event: RaceEvent): { evidence: string; quality: string | null } {
  return {
    evidence: EVIDENCE_BADGES[event.evidenceKind].label,
    quality: event.qualityState === "available" ? null : QUALITY_BADGES[event.qualityState].label,
  };
}

function sourceTimeContext(event: RaceEvent): string | null {
  if (event.sourceTimeMs == null) return null;
  if (event.sourceEndTimeMs != null && event.sourceEndTimeMs !== event.sourceTimeMs) {
    return `Source ${formatMilliseconds(event.sourceTimeMs)}–${formatMilliseconds(event.sourceEndTimeMs)}`;
  }
  return `Source ${formatMilliseconds(event.sourceTimeMs)}`;
}

function DiagnosticRow({ label, value }: { label: string; value: string | number | null }) {
  if (value == null || value === "") return null;
  return (
    <div className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-3">
      <dt className="text-app-label text-app-text-muted">{label}</dt>
      <dd className="min-w-0 break-all text-app-detail text-app-text-secondary">{value}</dd>
    </div>
  );
}

function TimelineEvent({ event }: { event: RaceEvent }) {
  const evidence = EVIDENCE_BADGES[event.evidenceKind];
  const quality = event.qualityState === "available" ? null : QUALITY_BADGES[event.qualityState];
  const details = formatRaceEventDetails(event);
  const sourceContext = sourceTimeContext(event);

  return (
    <Collapsible className="rounded-lg border border-app-border bg-app-surface">
      <CollapsibleTrigger render={<Button variant="plain" size="content" className="w-full" />}>
        <div className="flex w-full flex-col gap-2 px-3 py-3 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-app-subtext font-semibold text-app-text">{RACE_EVENT_LABELS[event.eventType]}</span>
            <Badge variant={evidence.variant} size="compact">
              {evidence.label}
            </Badge>
            {quality && (
              <Badge variant={quality.variant} size="compact">
                {quality.label}
              </Badge>
            )}
            <span className="ml-auto text-app-label text-app-text-muted">Diagnostics</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-app-detail text-app-text-muted">
            {event.lapNumber != null && <span>Lap {event.lapNumber}</span>}
            {sourceContext && <span>{sourceContext}</span>}
            {event.participantId && <span>Participant {event.participantId}</span>}
          </div>
          {details.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-app-detail text-app-text-secondary">
              {details.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
            </div>
          )}
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent className="bg-app-surface-alt px-3 py-3">
        <dl className="flex flex-col gap-2">
          <DiagnosticRow label="Event ID" value={event.eventId} />
          <DiagnosticRow label="Detector" value={`${event.detectorId} ${event.detectorVersion}`} />
          <DiagnosticRow label="Native sequence" value={event.sourceSequence == null ? event.sourceSequenceFamily : `${event.sourceSequenceFamily ?? "native"} ${event.sourceSequence}`} />
          <DiagnosticRow label="Source time" value={sourceContext?.replace(/^Source /, "") ?? null} />
          <DiagnosticRow label="Received at" value={`${formatNumber(event.receivedAtMs)} ms`} />
          <DiagnosticRow label="Confidence" value={event.confidence} />
          <DiagnosticRow label="Quality" value={event.qualityState} />
          <DiagnosticRow label="Lifecycle ID" value={event.lifecycleId} />
          <DiagnosticRow label="Linked event ID" value={event.linkedEventId} />
          <DiagnosticRow label="Lap ID" value={event.lapId} />
          <DiagnosticRow label="Source generation" value={event.sourceGeneration} />
          <DiagnosticRow label="Analysis generation" value={event.analysisGenerationId} />
        </dl>
        <div className="mt-3 flex flex-col gap-1">
          <div className="text-app-label font-semibold uppercase tracking-app-label text-app-text-muted">Payload</div>
          <pre className="overflow-x-auto rounded bg-app-bg p-2 text-app-detail text-app-text-secondary">{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RaceEventTimeline({ sessionId, enabled }: { sessionId: number; enabled: boolean }) {
  const timelineQuery = useSessionRaceEvents(sessionId, enabled);

  if (timelineQuery.isLoading) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">Loading race timeline…</div>;
  }
  if (timelineQuery.isError) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">Race timeline unavailable.</div>;
  }

  const events = flattenRaceEventPages(timelineQuery.data?.pages ?? []);
  if (events.length === 0) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">No race events recorded.</div>;
  }

  return (
    <section aria-label="Race event timeline" className="border-b border-app-border bg-app-surface-alt px-4 py-4">
      <div className="mb-3 text-app-caption font-semibold uppercase tracking-app-label text-app-text-muted">Race timeline</div>
      <div className="flex flex-col gap-2">
        {events.map((event) => (
          <TimelineEvent key={event.eventId} event={event} />
        ))}
      </div>
      {timelineQuery.hasNextPage && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <Button variant="app-outline" size="app-sm" disabled={timelineQuery.isFetchingNextPage} onClick={() => void timelineQuery.fetchNextPage()}>
            {timelineQuery.isFetchingNextPage ? "Loading more…" : "Load more events"}
          </Button>
          {timelineQuery.isFetchNextPageError && <div className="text-app-detail text-status-danger">More race events could not be loaded.</div>}
        </div>
      )}
    </section>
  );
}
