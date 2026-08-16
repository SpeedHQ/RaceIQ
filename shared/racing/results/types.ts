import type { GameId } from "@shared/games/ids";
import type { EligibilityDecision, EligibilityPolicyId, EligibilityStatus, QualityReasonCode } from "@shared/racing/quality/contracts";

export type RaceResultSourceStatus = "direct" | "derived" | "simplified" | "unavailable";
export type RaceResultOutcomeStatus = "confirmed" | "provisional" | "unavailable";
export type RaceResultStatus = "finished" | "dnf" | "disqualified" | "not-classified" | "retired" | "qualifying" | "unknown";

export type RaceResultAuthorityStrategy = "highest-authority" | "preserve-alternatives" | "require-consensus" | "abstain-on-conflict";

export type RaceResultEvidenceKind = "deterministic" | "ml" | "human";

export interface RaceResultClaimScope {
  claimId: string;
  entityId: string;
  validFrom: number;
  validTo: number;
}

export interface RaceResultClaimEvidence<T = unknown> extends RaceResultClaimScope {
  id: string;
  value: T;
  authority: string;
  kind: RaceResultEvidenceKind;
  confidence: number;
  observedAt: number;
  valid: boolean;
  applicable: boolean;
  validated: boolean;
  provenance: RaceResultProvenance;
}

export interface RaceResultAuthorityRule {
  authority: string;
  minConfidence?: number;
  maxConfidence?: number;
  minAgeMs?: number;
  maxAgeMs?: number;
}

export interface RaceResultAuthorityPolicy {
  id: string;
  version: string;
  strategy: RaceResultAuthorityStrategy;
  /** Highest authority first. Evidence from omitted authorities is rejected. */
  permittedAuthorities: readonly RaceResultAuthorityRule[];
  confidence: {
    min: number;
    max: number;
  };
  ageMs: {
    min: number;
    max: number;
  };
  consensus?: {
    minimumAuthorities: number;
  };
}

export type RaceResultEvidenceRejectionReason =
  | "different-claim"
  | "different-entity"
  | "different-time-interval"
  | "authority-not-permitted"
  | "invalid"
  | "inapplicable"
  | "unvalidated"
  | "confidence-out-of-bounds"
  | "stale"
  | "not-yet-observed";

export interface RaceResultRejectedEvidence {
  evidenceId: string;
  reason: RaceResultEvidenceRejectionReason;
}

export interface RaceResultClaimAlternative<T = unknown> {
  value: T;
  authority: string;
  authorities: string[];
  evidenceIds: string[];
}

export interface RaceResultAuthorityDecision<T = unknown> {
  policyId: string;
  policyVersion: string;
  scope: RaceResultClaimScope;
  status: "accepted" | "alternatives" | "consensus" | "abstained" | "unavailable";
  value: T | null;
  acceptedEvidenceIds: string[];
  alternatives: RaceResultClaimAlternative<T>[];
  rejected: RaceResultRejectedEvidence[];
  conflictReasons: string[];
}

export interface RaceResultRawInputIdentity {
  objectId: string;
  contentHash: string;
  byteOffset?: number;
  byteLength?: number;
}

export interface RaceResultCanonicalInputIdentity {
  sessionId: string;
  firstSequence: number;
  lastSequence: number;
  contentHash: string;
}

export interface RaceResultProvenance {
  catalogVersion: string;
  catalogHash: string;
  catalogSchemaVersion: string;
  parserVersion: string;
  resolverVersion: string;
  derivationId: string;
  derivationVersion: string;
  derivationCodeHash: string;
  rawInput: RaceResultRawInputIdentity | null;
  canonicalInput: RaceResultCanonicalInputIdentity | null;
  authorityPolicyId: string;
  authorityPolicyVersion: string;
  extractor?: {
    id: string;
    version: string;
  };
  fields?: Record<string, unknown>;
}

export interface RaceResultEvidence {
  fieldStatus: {
    sessionType: RaceResultSourceStatus;
    classification: RaceResultSourceStatus;
    finishingPosition: RaceResultSourceStatus;
    qualifyingPosition: RaceResultSourceStatus;
    isPodium: RaceResultSourceStatus;
    isFastestLap: RaceResultSourceStatus;
    pitEvents: RaceResultSourceStatus;
    tyreStrategy: RaceResultSourceStatus;
    fuelStrategy: RaceResultSourceStatus;
  };
  conflicts: string[];
  decisions?: Record<string, RaceResultAuthorityDecision>;
}
export interface RaceResultLapQualityEvidence {
  lapId: number;
  lapNumber: number;
  qualityGeneration: string | null;
  officialTiming: EligibilityDecision;
  normalPace: EligibilityDecision;
}

export type RaceResultEligibilityStatusCounts = Record<EligibilityStatus, number>;

export interface RaceResultPolicyQualityAggregate {
  policyId: EligibilityPolicyId;
  policyVersions: string[];
  statuses: RaceResultEligibilityStatusCounts;
  reasons: Partial<Record<QualityReasonCode, number>>;
}

export interface RaceResultLapQualityAggregate {
  evidenceGeneration: string | null;
  total: number;
  officialTiming: RaceResultPolicyQualityAggregate;
  normalPace: RaceResultPolicyQualityAggregate;
}

export interface RaceResult {
  id: number;
  sessionId: number;
  gameId: GameId;
  processorVersion: string;
  sessionType: string;
  classification: RaceResultStatus;
  finishingPosition: number | null;
  qualifyingPosition: number | null;
  isPodium: boolean | null;
  isFastestLap: boolean | null;
  pitCount: number;
  tyreStrategy: unknown;
  fuelStrategy: unknown;
  provenance: RaceResultProvenance;
  reasons: string[];
  outcomeStatus: RaceResultOutcomeStatus;
  evidence: RaceResultEvidence;
  lapQuality: RaceResultLapQualityEvidence[];
  events: Array<{
    eventType?: "pit" | "position-change";
    sequence: number;
    lapNumber: number | null;
    elapsedSeconds: number | null;
    durationSeconds: number | null;
    service: "tyres" | "fuel" | "combined" | "unknown";
    tyreChange: unknown;
    fuelAdded: number | null;
    fuelBefore: number | null;
    fuelAfter: number | null;
    positionBefore?: number | null;
    positionAfter?: number | null;
    linkage: "linked" | "unlinked" | "unknown";
    source: unknown;
  }>;
}

export interface RaceResultAggregate {
  gameId: GameId;
  sessions: number;
  finished: number;
  dnf: number;
  retired: number;
  qualifying: number;
  disqualified: number;
  notClassified: number;
  unknown: number;
  podiums: number;
  fastestLaps: number;
  pitStops: number;
  pitDurationSeconds: number | null;
  qualifyingToRaceMovement: number | null;
  tyreStrategyAvailable: boolean;
  fuelStrategyAvailable: boolean;
  confirmed: number;
  provisional: number;
  unavailable: number;
  lapQuality: RaceResultLapQualityAggregate;
}
