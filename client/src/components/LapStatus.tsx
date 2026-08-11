import { isPaceEligible, lapClassificationLabel, lapClassificationTone, type ClassifiedLap, type LapClassificationTone } from "@shared/racing/laps/classification";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

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

const INVALID_REASON_LABELS: Record<string, string> = {
  "too few telemetry packets": "No telemetry",
  "telemetry distance too short": "Short distance",
  "telemetry lap time mismatch": "Time mismatch",
  "starting lap": "Starting lap",
  "start/end positions too far apart": "Position jump",
  rewind: "Rewind",
  incomplete: "Incomplete",
};

const TEXT_TONE_CLASSES: Record<LapStatusTone, string> = {
  danger: "text-status-danger",
  success: "text-status-success",
  warning: "text-status-warning",
};

function invalidReasonLabel(reason?: string | null): string {
  if (!reason) return "Invalid";
  return INVALID_REASON_LABELS[reason] ?? (reason.startsWith("lap skip") ? "Lap skip" : reason[0].toUpperCase() + reason.slice(1));
}

export function resolveLapStatus(lap: LapStatusInput): ResolvedLapStatus {
  if (lap.isValid === false) {
    return {
      kind: "invalid",
      label: "Invalid",
      detailLabel: invalidReasonLabel(lap.invalidReason),
      tone: "danger",
      tooltip: lap.invalidReason ?? "Invalid lap",
    };
  }

  const label = lapClassificationLabel(lap);
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
    tooltip: "Valid pace lap",
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
  return (
    <span
      className={cn("inline-flex min-w-0 max-w-full items-center", indicator ? "text-sm leading-none" : "truncate text-app-caption font-medium", TEXT_TONE_CLASSES[status.tone])}
      title={status.tooltip}
      data-lap-status={status.kind}
    >
      {label}
    </span>
  );
}
