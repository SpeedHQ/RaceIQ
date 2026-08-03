import type {
  RaceResultClaimEvidence,
  RaceResultClaimScope,
} from "../../shared/racing/results/types";
import {
  arbitrateRaceResultClaim,
  RACE_RESULT_OUTCOME_POLICY,
  resolveRaceResultAuthorityFromSourceStatus,
  resolveRaceResultSourceStatusFromAuthority,
} from "./authority";
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

function classificationEvidence(
  source: RaceSourceObservation,
  sessionType: ResultSessionType,
): { scope: RaceResultClaimScope; claims: RaceResultClaimEvidence<ResultClassification>[]; now: number } {
  const claims = (source.claims ?? []).filter(
    (claim): claim is RaceResultClaimEvidence<ResultClassification> => claim.claimId === "race-result.classification",
  );
  const scope: RaceResultClaimScope = claims[0]
    ? {
        claimId: claims[0].claimId,
        entityId: claims[0].entityId,
        validFrom: claims[0].validFrom,
        validTo: claims[0].validTo,
      }
    : {
        claimId: "race-result.classification",
        entityId: `${source.gameId}:player`,
        validFrom: 0,
        validTo: Number.MAX_SAFE_INTEGER,
      };
  if (claims.length === 0) {
    if (sessionType === "qualifying") {
      claims.push({
        ...scope,
        id: "classification:qualifying-fallback",
        value: "qualifying",
        authority: "canonical-derivation",
        kind: "deterministic",
        confidence: 1,
        observedAt: 0,
        valid: true,
        applicable: true,
        validated: true,
        provenance: source.provenance,
      });
    } else if (source.classification) {
      const status = source.evidence.fieldStatus.classification;
      claims.push({
        ...scope,
        id: "classification:source",
        value: source.classification,
        authority: resolveRaceResultAuthorityFromSourceStatus(status),
        kind: "deterministic",
        confidence: status === "direct" ? 1 : 0.7,
        observedAt: 0,
        valid: true,
        applicable: true,
        validated: true,
        provenance: source.provenance,
      });
    } else if (sessionType === "race" && source.finishingPosition != null && source.finishingPosition > 0) {
      claims.push({
        ...scope,
        id: "classification:position-fallback",
        value: "finished",
        authority: "canonical-derivation",
        kind: "deterministic",
        confidence: 1,
        observedAt: 0,
        valid: true,
        applicable: true,
        validated: true,
        provenance: source.provenance,
      });
    }
  }
  return { scope, claims, now: claims.reduce((latest, claim) => Math.max(latest, claim.observedAt), 0) };
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
  const classificationInput = classificationEvidence(source, sessionType);
  const classificationDecision = arbitrateRaceResultClaim(
    classificationInput.scope,
    classificationInput.claims,
    RACE_RESULT_OUTCOME_POLICY,
    classificationInput.now,
  );
  const classification = (classificationDecision.value ?? "unknown") as ResultClassification;
  const winningEvidence = classificationInput.claims.find(
    (claim) => classificationDecision.acceptedEvidenceIds[0] === claim.id,
  );
  const classificationResult = {
    classification,
    status: resolveRaceResultSourceStatusFromAuthority(winningEvidence?.authority),
  };
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

  const outcomeStatus = classification === "unknown" || classificationDecision.status === "abstained" || classificationDecision.status === "unavailable"
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
    provenance: source.provenance,
    outcomeStatus,
    evidence: {
      fieldStatus,
      decisions: {
        ...source.evidence.decisions,
        classification: classificationDecision,
      },
      conflicts: [...new Set(conflicts)],
    },
    reasons: [...new Set(reasons)],
  };
}
