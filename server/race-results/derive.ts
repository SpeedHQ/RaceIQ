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

function resolveClassification(
  source: RaceSourceObservation,
  sessionType: ResultSessionType,
): { classification: ResultClassification; status: "direct" | "derived" | "simplified" | "unavailable" } {
  if (source.classification) {
    const sourceStatus = source.evidence.fieldStatus.classification;
    return {
      classification: source.classification,
      status: sourceStatus === "unavailable" ? "derived" : sourceStatus,
    };
  }
  if (sessionType === "qualifying") return { classification: "qualifying", status: "derived" };
  return { classification: "unknown", status: "unavailable" };
}

function derivePodium(position: number | null, classification: ResultClassification): boolean | null {
  if (position == null || position <= 0 || classification === "unknown") return null;
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
  const classificationResult = resolveClassification(source, sessionType);
  const classification = classificationResult.classification;
  const events = stableEvents(source.pitEvents);
  const reasons = [...new Set(source.reasons)];
  const conflicts = [...source.evidence.conflicts];
  const fieldStatus = { ...source.evidence.fieldStatus };
  fieldStatus.classification = classificationResult.status;

  if (source.classification && sessionType === "qualifying" && source.classification !== "qualifying") {
    conflicts.push(`classification-vs-session-type:${source.classification}|${sessionType}`);
  }
  const isPodium = derivePodium(source.finishingPosition ?? null, classification);
  fieldStatus.isPodium = isPodium == null ? "unavailable" : "derived";

  if (!source.sessionType) reasons.push("session-type-missing");
  if (source.finishingPosition == null && sessionType === "race") reasons.push("finishing-position-unknown");
  if (source.isFastestLap == null) reasons.push("fastest-lap-unknown");
  if (events.length === 0 && source.pitEvents == null) reasons.push("pit-ledger-unsupported");
  if (classificationResult.status === "derived") reasons.push("classification-derived-fallback");
  if (classificationResult.status === "simplified") reasons.push("classification-provisional-source");
  if (classificationResult.status === "unavailable") reasons.push("classification-unavailable");
  if (conflicts.length > 0) reasons.push("source-conflict");

  const outcomeStatus = classification === "unknown"
    ? "unavailable"
    : classificationResult.status === "direct" && conflicts.length === 0
      ? "confirmed"
      : "provisional";

  return {
    sessionType,
    classification,
    finishingPosition: source.finishingPosition ?? null,
    qualifyingPosition: source.qualifyingPosition ?? null,
    isPodium,
    isFastestLap: source.isFastestLap ?? null,
    pitCount: events.length,
    events,
    tyreStrategy: source.tyreStrategy ?? null,
    fuelStrategy: source.fuelStrategy ?? null,
    provenance: {
      ...source.provenance,
      derivation: {
        id: "race-result-derivation",
        version: "2",
        classificationFallback: classificationResult.status === "derived",
      },
    },
    outcomeStatus,
    evidence: {
      fieldStatus,
      conflicts: [...new Set(conflicts)],
    },
    reasons: [...new Set(reasons)],
  };
}
