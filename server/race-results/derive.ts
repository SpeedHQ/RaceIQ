import type {
  DerivedRaceResult,
  PitEvent,
  RaceSourceObservation,
  ResultClassification,
  ResultSessionType,
} from "./types";

const SESSION_TYPES: Record<string, ResultSessionType> = {
  practice: "practice",
  race: "race",
  qualifying: "qualifying",
  qualification: "qualifying",
  other: "other",
};

export function normalizeSessionType(value: string | null | undefined): ResultSessionType {
  if (!value) return "unknown";
  const normalized = value.trim().toLowerCase();
  if (SESSION_TYPES[normalized]) return SESSION_TYPES[normalized];
  if (normalized.startsWith("practice")) return "practice";
  if (normalized.startsWith("qualif")) return "qualifying";
  if (normalized.startsWith("race")) return "race";
  return "other";
}

function normalizeClassification(
  source: RaceSourceObservation,
  sessionType: ResultSessionType,
): ResultClassification {
  if (sessionType === "qualifying") return "qualifying";
  if (source.classification) return source.classification;
  if (sessionType === "race" && source.finishingPosition != null && source.finishingPosition > 0) return "finished";
  return "unknown";
}

function derivePodium(position: number | null, classification: ResultClassification): boolean | null {
  if (position == null || position <= 0) return null;
  if (classification !== "finished") return false;
  return position <= 3;
}

function stableEvents(events: PitEvent[] | undefined): PitEvent[] {
  return [...(events ?? [])]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event, index) => ({ ...event, sequence: index + 1 }));
}

export function deriveRaceResult(source: RaceSourceObservation): DerivedRaceResult {
  const sessionType = normalizeSessionType(source.sessionType);
  const classification = normalizeClassification(source, sessionType);
  const events = stableEvents(source.pitEvents);
  const reasons = [...new Set(source.reasons)];
  const provenance = { ...source.provenance };

  if (!source.sessionType) reasons.push("session-type-missing");
  if (source.finishingPosition == null && sessionType === "race") reasons.push("finishing-position-unknown");
  if (source.isFastestLap == null) reasons.push("fastest-lap-unknown");
  if (events.length === 0 && source.pitEvents == null) reasons.push("pit-ledger-unsupported");

  return {
    sessionType,
    classification,
    finishingPosition: source.finishingPosition ?? null,
    qualifyingPosition: source.qualifyingPosition ?? null,
    isPodium: derivePodium(source.finishingPosition ?? null, classification),
    isFastestLap: source.isFastestLap ?? null,
    pitCount: events.length,
    events,
    tyreStrategy: source.tyreStrategy ?? null,
    fuelStrategy: source.fuelStrategy ?? null,
    provenance,
    reasons: [...new Set(reasons)],
  };
}
