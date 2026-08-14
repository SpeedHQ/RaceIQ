import {
  isPaceEligible,
  lapClassificationTone,
  type ClassifiedLap,
  type LapClassificationTone,
  type LapCondition,
  type LapPhase,
} from "@shared/racing/laps/classification";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export type LapStatusKind = "invalid" | "non-pace" | "pace";
export type LapStatusTone = "danger" | LapClassificationTone;

export interface LapStatusInput extends ClassifiedLap {
  isValid?: boolean;
  invalidReason?: string | null;
}

export interface ResolvedLapStatus {
  kind: LapStatusKind;
  label: string;
  detailLabel: string;
  tone: LapStatusTone;
  tooltip: string;
}

const INVALID_REASON_LABELS: Record<string, () => string> = {
  "too few telemetry packets": m.lap_status_no_telemetry,
  "telemetry distance too short": m.lap_status_short_distance,
  "telemetry lap time mismatch": m.lap_status_time_mismatch,
  "starting lap": m.lap_status_starting_lap,
  "start/end positions too far apart": m.lap_status_position_jump,
  rewind: m.lap_status_rewind,
  incomplete: m.lap_status_incomplete,
};

const PHASE_LABELS: Record<LapPhase, () => string> = {
  flying: m.lap_status_pace,
  out: m.lap_status_out_lap,
  in: m.lap_status_in_lap,
  pit: m.lap_status_pit_lap,
  grid_start: m.lap_status_grid_start,
};

const CONDITION_LABELS: Record<LapCondition, () => string> = {
  caution: m.lap_status_caution,
  slow_zone: m.lap_status_slow_zone,
  formation: m.lap_status_formation,
};

const TEXT_TONE_CLASSES: Record<LapStatusTone, string> = {
  danger: "text-status-danger",
  success: "text-status-success",
  warning: "text-status-warning",
};

function invalidReasonLabel(reason?: string | null): string {
  if (!reason) return m.lap_status_invalid();
  return INVALID_REASON_LABELS[reason]?.() ?? (reason.startsWith("lap skip") ? m.lap_status_lap_skip() : reason[0].toUpperCase() + reason.slice(1));
}

function localizedLapClassificationLabel(lap: ClassifiedLap): string {
  const phase = lap.phase ?? "flying";
  const parts = phase === "flying" ? [] : [PHASE_LABELS[phase]()];
  parts.push(...(lap.conditions ?? []).map((condition) => CONDITION_LABELS[condition]()));
  return parts.length > 0 ? parts.join(" · ") : PHASE_LABELS.flying();
}

export function resolveLapStatus(lap: LapStatusInput): ResolvedLapStatus {
  if (lap.isValid === false) {
    const detailLabel = invalidReasonLabel(lap.invalidReason);
    return {
      kind: "invalid",
      label: m.lap_status_invalid(),
      detailLabel,
      tone: "danger",
      tooltip: lap.invalidReason ? detailLabel : m.lap_status_invalid_lap(),
    };
  }

  const label = localizedLapClassificationLabel(lap);
  const tone = lapClassificationTone(lap);
  if (!isPaceEligible(lap)) {
    return {
      kind: "non-pace",
      label,
      detailLabel: label,
      tone,
      tooltip: label,
    };
  }

  return {
    kind: "pace",
    label,
    detailLabel: label,
    tone,
    tooltip: m.lap_status_valid_pace_lap(),
  };
}

type LapStatusPresentation = "text" | "indicator" | "compact" | "badge";
export type LapStatusVisibility = "all" | "invalid" | "non-pace" | "pace" | "issues";

interface LapStatusProps {
  lap: LapStatusInput;
  presentation?: LapStatusPresentation;
  visibility?: LapStatusVisibility;
}

function isVisible(kind: LapStatusKind, visibility: LapStatusVisibility): boolean {
  if (visibility === "all") return true;
  if (visibility === "issues") return kind !== "pace";
  return kind === visibility;
}
export function lapStatusLabel(lap: LapStatusInput, visibility: LapStatusVisibility = "all"): string | null {
  const status = resolveLapStatus(lap);
  return isVisible(status.kind, visibility) ? status.label : null;
}


export function LapStatus({ lap, presentation = "text", visibility = "all" }: LapStatusProps) {
  const status = resolveLapStatus(lap);
  if (!isVisible(status.kind, visibility)) return null;

  if (presentation === "badge" || (presentation === "compact" && status.kind === "non-pace")) {
    return (
      <Badge variant={status.tone} size="compact" title={status.tooltip} data-lap-status={status.kind}>
        {status.label}
      </Badge>
    );
  }

  const indicator = presentation === "indicator" || presentation === "compact";
  const label = indicator ? (status.kind === "invalid" ? "✕" : status.kind === "pace" ? "✓" : status.label) : status.detailLabel;
  const assistiveLabel = status.kind === "invalid" && status.detailLabel !== status.label ? `${status.label}: ${status.detailLabel}` : status.detailLabel;
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center", indicator ? "text-sm leading-none" : "truncate text-app-caption font-medium", TEXT_TONE_CLASSES[status.tone])}
      title={status.tooltip}
      aria-label={indicator ? assistiveLabel : undefined}
      role={indicator ? "img" : undefined}
      data-lap-status={status.kind}
    >
      {label}
    </span>
  );
}
