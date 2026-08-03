import type {
  RaceResultAuthorityDecision,
  RaceResultAuthorityPolicy,
  RaceResultClaimAlternative,
  RaceResultClaimEvidence,
  RaceResultClaimScope,
  RaceResultEvidenceRejectionReason,
  RaceResultSourceStatus,
} from "../../shared/racing/results/types";

export function resolveRaceResultSourceStatusFromAuthority(authority: string | undefined): RaceResultSourceStatus {
  if (authority === "simulator-final") return "direct";
  if (authority === "canonical-derivation") return "derived";
  if (authority) return "simplified";
  return "unavailable";
}

export function resolveRaceResultAuthorityFromSourceStatus(status: RaceResultSourceStatus): string {
  if (status === "direct") return "simulator-final";
  if (status === "derived" || status === "unavailable") return "canonical-derivation";
  return "simulator-live";
}

export const RACE_RESULT_OUTCOME_POLICY: RaceResultAuthorityPolicy = {
  id: "race-result-outcome-authority",
  version: "1",
  strategy: "highest-authority",
  permittedAuthorities: [
    { authority: "simulator-final" },
    { authority: "canonical-derivation" },
    { authority: "simulator-live" },
    { authority: "validated-ml" },
  ],
  confidence: { min: 0, max: 1 },
  ageMs: { min: 0, max: Number.POSITIVE_INFINITY },
};

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${value}`;
    case "string":
      return `string:${JSON.stringify(value)}`;
    case "boolean":
      return `boolean:${value}`;
    case "bigint":
      return `bigint:${value}`;
    case "undefined":
      return "undefined";
    case "object": {
      if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`).join(",")}}`;
    }
    default:
      return `${typeof value}:${String(value)}`;
  }
}

function rejectionReason<T>(
  evidence: RaceResultClaimEvidence<T>,
  scope: RaceResultClaimScope,
  policy: RaceResultAuthorityPolicy,
  now: number,
): RaceResultEvidenceRejectionReason | null {
  if (evidence.claimId !== scope.claimId) return "different-claim";
  if (evidence.entityId !== scope.entityId) return "different-entity";
  if (evidence.validFrom !== scope.validFrom || evidence.validTo !== scope.validTo) return "different-time-interval";
  const authority = policy.permittedAuthorities.find((candidate) => candidate.authority === evidence.authority);
  if (!authority) return "authority-not-permitted";
  if (!evidence.valid) return "invalid";
  if (!evidence.applicable) return "inapplicable";
  if (!evidence.validated) return "unvalidated";
  const minimumConfidence = Math.max(policy.confidence.min, authority.minConfidence ?? Number.NEGATIVE_INFINITY);
  const maximumConfidence = Math.min(policy.confidence.max, authority.maxConfidence ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(evidence.confidence) || evidence.confidence < minimumConfidence || evidence.confidence > maximumConfidence) {
    return "confidence-out-of-bounds";
  }
  const age = now - evidence.observedAt;
  const minimumAge = Math.max(policy.ageMs.min, authority.minAgeMs ?? Number.NEGATIVE_INFINITY);
  const maximumAge = Math.min(policy.ageMs.max, authority.maxAgeMs ?? Number.POSITIVE_INFINITY);
  if (age < 0) return "not-yet-observed";
  if (age < minimumAge || age > maximumAge) return "stale";
  return null;
}

function rank(policy: RaceResultAuthorityPolicy, authority: string): number {
  return policy.permittedAuthorities.findIndex((candidate) => candidate.authority === authority);
}

function compareEvidence<T>(policy: RaceResultAuthorityPolicy, left: RaceResultClaimEvidence<T>, right: RaceResultClaimEvidence<T>): number {
  const authority = rank(policy, left.authority) - rank(policy, right.authority);
  if (authority !== 0) return authority;
  const confidence = right.confidence - left.confidence;
  if (confidence !== 0) return confidence;
  const observed = right.observedAt - left.observedAt;
  if (observed !== 0) return observed;
  return left.id.localeCompare(right.id);
}

function alternativesFor<T>(
  accepted: readonly RaceResultClaimEvidence<T>[],
  policy: RaceResultAuthorityPolicy,
): RaceResultClaimAlternative<T>[] {
  const groups = new Map<string, { value: T; evidence: RaceResultClaimEvidence<T>[] }>();
  for (const evidence of accepted) {
    const key = canonicalValue(evidence.value);
    const group = groups.get(key);
    if (group) group.evidence.push(evidence);
    else groups.set(key, { value: evidence.value, evidence: [evidence] });
  }
  return [...groups.values()]
    .sort((left, right) => compareEvidence(policy, left.evidence[0]!, right.evidence[0]!))
    .map((group) => ({
      value: group.value,
      authority: group.evidence[0]!.authority,
      authorities: [...new Set(group.evidence.map((evidence) => evidence.authority))],
      evidenceIds: group.evidence.map((evidence) => evidence.id),
    }));
}

export function arbitrateRaceResultClaim<T>(
  scope: RaceResultClaimScope,
  evidence: readonly RaceResultClaimEvidence<T>[],
  policy: RaceResultAuthorityPolicy,
  now: number,
): RaceResultAuthorityDecision<T> {
  const accepted: RaceResultClaimEvidence<T>[] = [];
  const rejected: RaceResultAuthorityDecision<T>["rejected"] = [];
  for (const candidate of evidence) {
    const reason = rejectionReason(candidate, scope, policy, now);
    if (reason) rejected.push({ evidenceId: candidate.id, reason });
    else accepted.push(candidate);
  }
  accepted.sort((left, right) => compareEvidence(policy, left, right));
  const alternatives = alternativesFor(accepted, policy);
  const base = {
    policyId: policy.id,
    policyVersion: policy.version,
    scope,
    rejected,
    alternatives,
  };
  if (accepted.length === 0) {
    return { ...base, status: "unavailable", value: null, acceptedEvidenceIds: [], conflictReasons: ["no-valid-evidence"] };
  }

  const conflictReasons = alternatives.length > 1
    ? [`conflicting-values:${alternatives.flatMap((alternative) => alternative.evidenceIds).join("|")}`]
    : [];
  if (policy.strategy === "highest-authority") {
    const winner = accepted[0]!;
    return { ...base, status: "accepted", value: winner.value, acceptedEvidenceIds: [winner.id], conflictReasons };
  }
  if (policy.strategy === "preserve-alternatives" && alternatives.length > 1) {
    return { ...base, status: "alternatives", value: null, acceptedEvidenceIds: accepted.map((candidate) => candidate.id), conflictReasons };
  }
  if (policy.strategy === "abstain-on-conflict" && alternatives.length > 1) {
    return { ...base, status: "abstained", value: null, acceptedEvidenceIds: [], conflictReasons };
  }
  if (policy.strategy === "require-consensus") {
    const minimumAuthorities = Math.max(2, policy.consensus?.minimumAuthorities ?? 2);
    const consensus = alternatives.filter((alternative) => {
      const authorities = new Set(
        accepted.filter((candidate) => canonicalValue(candidate.value) === canonicalValue(alternative.value)).map((candidate) => candidate.authority),
      );
      return authorities.size >= minimumAuthorities;
    });
    if (consensus.length !== 1) {
      return {
        ...base,
        status: "abstained",
        value: null,
        acceptedEvidenceIds: [],
        conflictReasons: [...conflictReasons, consensus.length === 0 ? "consensus-not-reached" : "multiple-consensus-values"],
      };
    }
    const valueKey = canonicalValue(consensus[0]!.value);
    return {
      ...base,
      status: "consensus",
      value: consensus[0]!.value,
      acceptedEvidenceIds: accepted.filter((candidate) => canonicalValue(candidate.value) === valueKey).map((candidate) => candidate.id),
      conflictReasons,
    };
  }
  return {
    ...base,
    status: "accepted",
    value: accepted[0]!.value,
    acceptedEvidenceIds: accepted.map((candidate) => candidate.id),
    conflictReasons,
  };
}
