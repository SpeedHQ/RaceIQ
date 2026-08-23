import type { LapMeta } from "@shared/racing/sessions/types";
import { Badge } from "@/components/ui/badge";

type LapStatusVisibility = "all" | "issues";
type LapStatusPresentation = "badge" | "indicator";
type LapStatusInput = Pick<
  LapMeta,
  "isValid" | "invalidReason" | "phase" | "conditions" | "paceEligibility"
>;

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function lapStatusLabel(
  lap: LapStatusInput,
  visibility: LapStatusVisibility = "all",
): string | null {
  const conditions = lap.conditions ?? [];
  if (!lap.isValid) return lap.invalidReason ? titleCase(lap.invalidReason) : "Invalid";
  if (lap.phase === "in") return "In lap";
  if (lap.phase === "out") return "Out lap";
  if (lap.phase === "pit") return "Pit lap";
  if (conditions.length > 0) return conditions.map(titleCase).join(", ");
  if (lap.paceEligibility === "excluded") return "Non-pace";
  return visibility === "issues" ? null : "Valid";
}

export function LapStatus({
  lap,
  presentation = "badge",
  visibility = "all",
}: {
  lap: LapStatusInput;
  presentation?: LapStatusPresentation;
  visibility?: LapStatusVisibility;
}) {
  const label = lapStatusLabel(lap, visibility);
  if (!label) return null;

  const invalid = !lap.isValid;
  if (presentation === "indicator") {
    return (
      <span
        aria-label={label}
        title={label}
        className={`inline-block size-2 shrink-0 rounded-full ${invalid ? "bg-status-danger" : "bg-status-warning"}`}
      />
    );
  }

  return (
    <Badge variant={invalid ? "danger" : label === "Valid" ? "success" : "warning"} size="compact">
      {label}
    </Badge>
  );
}
