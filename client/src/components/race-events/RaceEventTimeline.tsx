import type { GameId } from "@shared/games/ids";
import type { RaceEvent, RaceEventPage, RaceEventType } from "@shared/racing/events/contracts";

import { useSessionRaceEvents } from "@/hooks/session-queries";
import { canonicalRaceEvents } from "@/lib/race-event-cache";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

export const RACE_EVENT_LABELS: Record<RaceEventType, () => string> = {
  session_started: () => m.race_event_type_session_started(),
  session_ended: () => m.race_event_type_session_ended(),
  session_phase_changed: () => m.race_event_type_session_phase_changed(),
  green_flag: () => m.race_event_type_green_flag(),
  caution_started: () => m.race_event_type_caution_started(),
  caution_ended: () => m.race_event_type_caution_ended(),
  red_flag_started: () => m.race_event_type_red_flag_started(),
  checkered_flag: () => m.race_event_type_checkered_flag(),
  restart_started: () => m.race_event_type_restart_started(),
  timebase_reset: () => m.race_event_type_timebase_reset(),
  participant_joined: () => m.race_event_type_participant_joined(),
  participant_became_unavailable: () => m.race_event_type_participant_became_unavailable(),
  participant_returned: () => m.race_event_type_participant_returned(),
  driver_started_stint: () => m.race_event_type_driver_started_stint(),
  driver_changed: () => m.race_event_type_driver_changed(),
  position_changed: () => m.race_event_type_position_changed(),
  lap_started: () => m.race_event_type_lap_started(),
  lap_completed: () => m.race_event_type_lap_completed(),
  sector_completed: () => m.race_event_type_sector_completed(),
  track_limit_or_lap_invalidated: () => m.race_event_type_track_limit_or_lap_invalidated(),
  pit_entry: () => m.race_event_type_pit_entry(),
  pit_stall_arrival: () => m.race_event_type_pit_stall_arrival(),
  pit_service_started: () => m.race_event_type_pit_service_started(),
  tire_service_observed: () => m.race_event_type_tire_service_observed(),
  fuel_service_observed: () => m.race_event_type_fuel_service_observed(),
  repair_service_observed: () => m.race_event_type_repair_service_observed(),
  driver_service_observed: () => m.race_event_type_driver_service_observed(),
  pit_service_completed: () => m.race_event_type_pit_service_completed(),
  pit_stall_departure: () => m.race_event_type_pit_stall_departure(),
  pit_exit: () => m.race_event_type_pit_exit(),
  pit_visit_incomplete: () => m.race_event_type_pit_visit_incomplete(),
  drive_through_observed: () => m.race_event_type_drive_through_observed(),
  incident_observed: () => m.race_event_type_incident_observed(),
  damage_warning_started: () => m.race_event_type_damage_warning_started(),
  damage_warning_cleared: () => m.race_event_type_damage_warning_cleared(),
  penalty_issued: () => m.race_event_type_penalty_issued(),
  penalty_cleared: () => m.race_event_type_penalty_cleared(),
  car_reset: () => m.race_event_type_car_reset(),
  fast_repair_used: () => m.race_event_type_fast_repair_used(),
  retirement_observed: () => m.race_event_type_retirement_observed(),
  source_connected: () => m.race_event_type_source_connected(),
  source_disconnected: () => m.race_event_type_source_disconnected(),
  source_stale: () => m.race_event_type_source_stale(),
  source_recovered: () => m.race_event_type_source_recovered(),
  telemetry_gap: () => m.race_event_type_telemetry_gap(),
  out_of_order_input: () => m.race_event_type_out_of_order_input(),
  duplicate_input_suppressed: () => m.race_event_type_duplicate_input_suppressed(),
  storage_drop: () => m.race_event_type_storage_drop(),
  storage_failure: () => m.race_event_type_storage_failure(),
  timeline_discontinuity: () => m.race_event_type_timeline_discontinuity(),
};

const PAYLOAD_FIELD_LABELS: Record<string, () => string> = {
  phase: () => m.race_event_payload_phase(),
  previousPhase: () => m.race_event_payload_previous_phase(),
  reason: () => m.race_event_payload_reason(),
  terminalObserved: () => m.race_event_payload_terminal_observed(),
  gridStart: () => m.race_event_payload_grid_start(),
  nativeCode: () => m.race_event_payload_native_code(),
  kind: () => m.race_event_payload_caution_kind(),
  previousSourceTimeMs: () => m.race_event_payload_previous_source_time(),
  currentSourceTimeMs: () => m.race_event_payload_current_source_time(),
  sourceId: () => m.race_event_payload_source_id(),
  identityState: () => m.race_event_payload_identity_state(),
  displayName: () => m.race_event_payload_display_name(),
  vehicleId: () => m.race_event_payload_vehicle_id(),
  previousDriverId: () => m.race_event_payload_previous_driver_id(),
  driverId: () => m.race_event_payload_driver_id(),
  previousDisplayName: () => m.race_event_payload_previous_driver(),
  previousPosition: () => m.race_event_payload_previous_position(),
  position: () => m.race_event_payload_position(),
  lapNumber: () => m.race_event_payload_lap(),
  lapTimeMs: () => m.race_event_payload_lap_time(),
  isValid: () => m.race_event_payload_valid_lap(),
  conditions: () => m.race_event_payload_conditions(),
  sectorIndex: () => m.race_event_payload_sector_index(),
  sectorTimeMs: () => m.race_event_payload_sector_time(),
  previousState: () => m.race_event_payload_previous_pit_state(),
  state: () => m.race_event_payload_pit_state(),
  trigger: () => m.race_event_payload_service_trigger(),
  changedCorners: () => m.race_event_payload_changed_corners(),
  previousCompound: () => m.race_event_payload_previous_compound(),
  currentCompound: () => m.race_event_payload_current_compound(),
  beforeWear: () => m.race_event_payload_wear_before_service(),
  afterWear: () => m.race_event_payload_wear_after_service(),
  beforeLitres: () => m.race_event_payload_fuel_before_service(),
  afterLitres: () => m.race_event_payload_fuel_after_service(),
  addedLitres: () => m.race_event_payload_fuel_added(),
  previousComponents: () => m.race_event_payload_components_before(),
  currentComponents: () => m.race_event_payload_components_after(),
  repairedComponents: () => m.race_event_payload_repaired_components(),
  durationMs: () => m.race_event_payload_duration(),
  observedActions: () => m.race_event_payload_observed_actions(),
  previousCount: () => m.race_event_payload_previous_incident_count(),
  currentCount: () => m.race_event_payload_incident_count(),
  delta: () => m.race_event_payload_incident_increase(),
  changedComponents: () => m.race_event_payload_changed_components(),
  previousValue: () => m.race_event_payload_previous_value(),
  currentValue: () => m.race_event_payload_current_value(),
  resolution: () => m.race_event_payload_resolution(),
  status: () => m.race_event_payload_status(),
  lifecycleKind: () => m.race_event_payload_lifecycle_state(),
  details: () => m.race_event_payload_details(),
  missingCount: () => m.race_event_payload_missing_observations(),
  countMethod: () => m.race_event_payload_count_method(),
  sourceSequenceFamily: () => m.race_event_payload_native_sequence_family(),
  previousSequence: () => m.race_event_payload_previous_native_sequence(),
  currentSequence: () => m.race_event_payload_current_native_sequence(),
  operation: () => m.race_event_payload_storage_operation(),
};

const EVIDENCE_BADGES = {
  observed: { label: () => m.race_event_evidence_observed(), variant: "success" },
  derived: { label: () => m.race_event_evidence_derived(), variant: "info" },
  inferred: { label: () => m.race_event_evidence_inferred(), variant: "warning" },
} as const;

const QUALITY_BADGES = {
  degraded: { label: () => m.race_event_quality_degraded(), variant: "warning" },
  ambiguous: { label: () => m.race_event_quality_ambiguous(), variant: "warning" },
  unavailable: { label: () => m.race_event_quality_unavailable(), variant: "danger" },
} as const;

const CONFIDENCE_LABELS = {
  high: () => m.race_event_confidence_high(),
  medium: () => m.race_event_confidence_medium(),
  low: () => m.race_event_confidence_low(),
  unknown: () => m.race_event_confidence_unknown(),
} as const;

const QUALITY_STATE_LABELS = {
  available: () => m.race_event_quality_available(),
  degraded: () => m.race_event_quality_degraded(),
  ambiguous: () => m.race_event_quality_ambiguous(),
  unavailable: () => m.race_event_quality_unavailable(),
} as const;

function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale(), { maximumFractionDigits: 3 }).format(value);
}

function formatMilliseconds(value: number): string {
  return `${formatNumber(value / 1_000)} s`;
}

const HUMANIZED_ENUM_FIELDS: Record<string, true> = {
  phase: true,
  previousPhase: true,
  kind: true,
  identityState: true,
  conditions: true,
  previousState: true,
  state: true,
  trigger: true,
  observedActions: true,
  resolution: true,
  countMethod: true,
};

const ENUM_FAMILY_BY_FIELD: Record<string, string> = {
  phase: "phase",
  previousPhase: "phase",
  kind: "caution_kind",
  identityState: "identity_state",
  conditions: "lap_condition",
  previousState: "pit_state",
  state: "pit_state",
  trigger: "service_trigger",
  observedActions: "service_action",
  resolution: "resolution",
  countMethod: "count_method",
};

const ENUM_LABELS: Record<string, () => string> = {
  "phase:unknown": () => m.race_event_enum_phase_unknown(),
  "phase:inactive": () => m.race_event_enum_phase_inactive(),
  "phase:formation": () => m.race_event_enum_phase_formation(),
  "phase:green": () => m.race_event_enum_phase_green(),
  "phase:caution": () => m.race_event_enum_phase_caution(),
  "phase:red": () => m.race_event_enum_phase_red(),
  "phase:checkered": () => m.race_event_enum_phase_checkered(),
  "phase:finished": () => m.race_event_enum_phase_finished(),
  "phase:flying": () => m.race_event_enum_phase_flying(),
  "phase:out": () => m.race_event_enum_phase_out(),
  "phase:in": () => m.race_event_enum_phase_in(),
  "phase:pit": () => m.race_event_enum_phase_pit(),
  "phase:grid_start": () => m.race_event_enum_phase_grid_start(),
  "caution_kind:local-yellow": () => m.race_event_enum_caution_kind_local_yellow(),
  "caution_kind:full-course-yellow": () => m.race_event_enum_caution_kind_full_course_yellow(),
  "caution_kind:safety-car": () => m.race_event_enum_caution_kind_safety_car(),
  "caution_kind:virtual-safety-car": () => m.race_event_enum_caution_kind_virtual_safety_car(),
  "caution_kind:unknown": () => m.race_event_enum_unknown(),
  "identity_state:stable": () => m.race_event_enum_identity_stable(),
  "identity_state:session-scoped": () => m.race_event_enum_identity_session_scoped(),
  "identity_state:unknown": () => m.race_event_enum_unknown(),
  "lap_condition:caution": () => m.race_event_enum_condition_caution(),
  "lap_condition:slow_zone": () => m.race_event_enum_condition_slow_zone(),
  "lap_condition:formation": () => m.race_event_enum_condition_formation(),
  "pit_state:out": () => m.race_event_enum_pit_state_out(),
  "pit_state:pit-lane": () => m.race_event_enum_pit_state_pit_lane(),
  "pit_state:pit-stall": () => m.race_event_enum_pit_state_pit_stall(),
  "pit_state:unknown": () => m.race_event_enum_unknown(),
  "service_trigger:stall": () => m.race_event_enum_service_trigger_stall(),
  "service_trigger:service-observation": () => m.race_event_enum_service_trigger_observation(),
  "service_action:tires": () => m.race_event_enum_service_action_tires(),
  "service_action:fuel": () => m.race_event_enum_service_action_fuel(),
  "service_action:repair": () => m.race_event_enum_service_action_repair(),
  "service_action:driver": () => m.race_event_enum_service_action_driver(),
  "resolution:unknown": () => m.race_event_enum_unknown(),
  "count_method:native-sequence": () => m.race_event_enum_count_method_native_sequence(),
  "count_method:timestamp-estimate": () => m.race_event_enum_count_method_timestamp_estimate(),
  "count_method:unavailable": () => m.race_event_enum_unavailable(),
};

function formatEnum(key: string, value: string): string {
  const family = ENUM_FAMILY_BY_FIELD[key];
  return family == null ? value : ENUM_LABELS[`${family}:${value}`]?.() ?? value;
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
    return value.map((item) => (typeof item === "string" && HUMANIZED_ENUM_FIELDS[key] ? formatEnum(key, item) : String(item))).join(", ");
  }
  if (typeof value === "boolean") return value ? m.race_event_value_yes() : m.race_event_value_no();
  if (typeof value === "number") {
    if (key.endsWith("Ms")) return formatMilliseconds(value);
    if (key.endsWith("Litres")) return `${formatNumber(value)} L`;
    return formatNumber(value);
  }
  if (typeof value === "string") return HUMANIZED_ENUM_FIELDS[key] ? formatEnum(key, value) : value;
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
    const label = PAYLOAD_FIELD_LABELS[key]?.() ?? key;
    return formatted == null ? [] : [`${label}: ${formatted}`];
  });
}

export function flattenRaceEventPages(pages: readonly RaceEventPage[]): RaceEvent[] {
  return canonicalRaceEvents(pages.flatMap((page) => page.items));
}

export function raceEventBadges(event: RaceEvent): { evidence: string; quality: string | null } {
  return {
    evidence: EVIDENCE_BADGES[event.evidenceKind].label(),
    quality: event.qualityState === "available" ? null : QUALITY_BADGES[event.qualityState].label(),
  };
}

function sourceTimeValue(event: RaceEvent): string | null {
  if (event.sourceTimeMs == null) return null;
  if (event.sourceEndTimeMs != null && event.sourceEndTimeMs !== event.sourceTimeMs) {
    return `${formatMilliseconds(event.sourceTimeMs)}–${formatMilliseconds(event.sourceEndTimeMs)}`;
  }
  return formatMilliseconds(event.sourceTimeMs);
}

function sourceTimeContext(event: RaceEvent): string | null {
  const time = sourceTimeValue(event);
  return time == null ? null : m.race_event_source_time({ time });
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
  const eventLabel = RACE_EVENT_LABELS[event.eventType]();
  const evidence = EVIDENCE_BADGES[event.evidenceKind];
  const quality = event.qualityState === "available" ? null : QUALITY_BADGES[event.qualityState];
  const details = formatRaceEventDetails(event);
  const sourceContext = sourceTimeContext(event);

  return (
    <Collapsible className="rounded-lg border border-app-border bg-app-surface">
      <CollapsibleTrigger render={<Button variant="plain" size="content" className="w-full" aria-label={m.race_event_aria_toggle({ event: eventLabel })} />}>
        <div className="flex w-full flex-col gap-2 px-3 py-3 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-app-subtext font-semibold text-app-text">{eventLabel}</span>
            <Badge variant={evidence.variant} size="compact">
              {evidence.label()}
            </Badge>
            {quality && (
              <Badge variant={quality.variant} size="compact">
                {quality.label()}
              </Badge>
            )}
            <span className="ml-auto text-app-label text-app-text-muted">{m.race_event_diagnostics()}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-app-detail text-app-text-muted">
            {event.lapNumber != null && <span>{m.race_event_lap({ lap: event.lapNumber })}</span>}
            {sourceContext && <span>{sourceContext}</span>}
            {event.participantId && <span>{m.race_event_participant({ id: event.participantId })}</span>}
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
          <DiagnosticRow label={m.race_event_diagnostic_event_id()} value={event.eventId} />
          <DiagnosticRow label={m.race_event_diagnostic_detector()} value={`${event.detectorId} ${event.detectorVersion}`} />
          <DiagnosticRow
            label={m.race_event_diagnostic_native_sequence()}
            value={event.sourceSequence == null ? event.sourceSequenceFamily : `${event.sourceSequenceFamily ?? m.race_event_native_default()} ${event.sourceSequence}`}
          />
          <DiagnosticRow label={m.race_event_diagnostic_source_time()} value={sourceTimeValue(event)} />
          <DiagnosticRow label={m.race_event_diagnostic_received_at()} value={`${formatNumber(event.receivedAtMs)} ms`} />
          <DiagnosticRow label={m.race_event_diagnostic_confidence()} value={CONFIDENCE_LABELS[event.confidence]()} />
          <DiagnosticRow label={m.race_event_diagnostic_quality()} value={QUALITY_STATE_LABELS[event.qualityState]()} />
          <DiagnosticRow label={m.race_event_diagnostic_lifecycle_id()} value={event.lifecycleId} />
          <DiagnosticRow label={m.race_event_diagnostic_linked_event_id()} value={event.linkedEventId} />
          <DiagnosticRow label={m.race_event_diagnostic_lap_id()} value={event.lapId} />
          <DiagnosticRow label={m.race_event_diagnostic_source_generation()} value={event.sourceGeneration} />
          <DiagnosticRow label={m.race_event_diagnostic_analysis_generation()} value={event.analysisGenerationId} />
        </dl>
        <div className="mt-3 flex flex-col gap-1">
          <div className="text-app-label font-semibold uppercase tracking-app-label text-app-text-muted">{m.race_event_payload()}</div>
          <pre className="overflow-x-auto rounded bg-app-bg p-2 text-app-detail text-app-text-secondary">{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function RaceEventTimeline({ sessionId, gameId, enabled }: { sessionId: number; gameId: GameId; enabled: boolean }) {
  const timelineQuery = useSessionRaceEvents(sessionId, gameId, enabled);

  if (timelineQuery.isLoading) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">{m.race_event_loading()}</div>;
  }
  if (timelineQuery.isError) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">{m.race_event_error()}</div>;
  }

  const events = flattenRaceEventPages(timelineQuery.data?.pages ?? []);
  if (events.length === 0) {
    return <div className="border-b border-app-border px-4 py-3 text-app-detail text-app-text-muted">{m.race_event_empty()}</div>;
  }

  return (
    <section aria-label={m.race_event_aria_timeline()} className="border-b border-app-border bg-app-surface-alt px-4 py-4">
      <div className="mb-3 text-app-caption font-semibold uppercase tracking-app-label text-app-text-muted">{m.race_event_title()}</div>
      <div className="flex flex-col gap-2">
        {events.map((event) => (
          <TimelineEvent key={event.eventId} event={event} />
        ))}
      </div>
      {timelineQuery.hasNextPage && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <Button variant="app-outline" size="app-sm" disabled={timelineQuery.isFetchingNextPage} onClick={() => void timelineQuery.fetchNextPage()}>
            {timelineQuery.isFetchingNextPage ? m.race_event_loading_more() : m.race_event_load_more()}
          </Button>
          {timelineQuery.isFetchNextPageError && <div className="text-app-detail text-status-danger">{m.race_event_load_more_error()}</div>}
        </div>
      )}
    </section>
  );
}
