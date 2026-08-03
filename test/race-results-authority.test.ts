import { describe, expect, test } from "bun:test";
import type {
  RaceResultAuthorityPolicy,
  RaceResultClaimEvidence,
  RaceResultClaimScope,
  RaceResultProvenance,
} from "../shared/race-results/types";
import { arbitrateRaceResultClaim } from "../server/race-results/authority";

const provenance: RaceResultProvenance = {
  catalogVersion: "catalog-1",
  catalogHash: "sha256:catalog",
  catalogSchemaVersion: "schema-1",
  parserVersion: "parser-1",
  resolverVersion: "resolver-1",
  derivationId: "classification",
  derivationVersion: "1",
  derivationCodeHash: "sha256:derivation",
  rawInput: { objectId: "raw-1", contentHash: "sha256:raw" },
  canonicalInput: { sessionId: "session-1", firstSequence: 0, lastSequence: 4, contentHash: "sha256:canonical" },
  authorityPolicyId: "test-policy",
  authorityPolicyVersion: "1",
};

const scope: RaceResultClaimScope = {
  claimId: "race-result.classification",
  entityId: "session-1:player",
  validFrom: 100,
  validTo: 200,
};

const policy = (strategy: RaceResultAuthorityPolicy["strategy"]): RaceResultAuthorityPolicy => ({
  id: "test-policy",
  version: "1",
  strategy,
  permittedAuthorities: [
    { authority: "deterministic", minConfidence: 0.5, maxAgeMs: 1_000 },
    { authority: "validated-ml", minConfidence: 0.8, maxAgeMs: 500 },
    { authority: "secondary" },
  ],
  confidence: { min: 0, max: 1 },
  ageMs: { min: 0, max: 2_000 },
  consensus: { minimumAuthorities: 2 },
});

const claim = (
  id: string,
  value: string,
  authority: string,
  overrides: Partial<RaceResultClaimEvidence<string>> = {},
): RaceResultClaimEvidence<string> => ({
  ...scope,
  id,
  value,
  authority,
  kind: authority === "validated-ml" ? "ml" : "deterministic",
  confidence: 0.9,
  observedAt: 9_500,
  valid: true,
  applicable: true,
  validated: true,
  provenance,
  ...overrides,
});

describe("race-result claim authority arbitration", () => {
  test("orders by configured authority before confidence or recency", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("ml", "dnf", "validated-ml", { confidence: 1, observedAt: 9_900 }),
      claim("deterministic", "finished", "deterministic", { confidence: 0.6, observedAt: 9_100 }),
    ], policy("highest-authority"), 10_000);

    expect(decision.status).toBe("accepted");
    expect(decision.value).toBe("finished");
    expect(decision.acceptedEvidenceIds).toEqual(["deterministic"]);
    expect(decision.alternatives.map((alternative) => alternative.value)).toEqual(["finished", "dnf"]);
    expect(decision.conflictReasons).toHaveLength(1);
  });

  test("rejects stale evidence instead of falling back to it", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("stale", "finished", "deterministic", { observedAt: 8_999 }),
    ], policy("highest-authority"), 10_000);

    expect(decision.status).toBe("unavailable");
    expect(decision.value).toBeNull();
    expect(decision.rejected).toEqual([{ evidenceId: "stale", reason: "stale" }]);
  });
  test("rejects invalid, inapplicable, unvalidated, and out-of-scope evidence", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("invalid", "finished", "deterministic", { valid: false }),
      claim("inapplicable", "finished", "deterministic", { applicable: false }),
      claim("unvalidated", "finished", "validated-ml", { validated: false }),
      claim("other-entity", "finished", "deterministic", { entityId: "session-2:player" }),
      claim("other-claim", "finished", "deterministic", { claimId: "race-result.position" }),
      claim("other-interval", "finished", "deterministic", { validTo: 201 }),
    ], policy("highest-authority"), 10_000);

    expect(decision.status).toBe("unavailable");
    expect(decision.rejected).toEqual([
      { evidenceId: "invalid", reason: "invalid" },
      { evidenceId: "inapplicable", reason: "inapplicable" },
      { evidenceId: "unvalidated", reason: "unvalidated" },
      { evidenceId: "other-entity", reason: "different-entity" },
      { evidenceId: "other-claim", reason: "different-claim" },
      { evidenceId: "other-interval", reason: "different-time-interval" },
    ]);
  });


  test("preserves conflicting deterministic and ML alternatives without averaging", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("deterministic", "finished", "deterministic"),
      claim("ml", "dnf", "validated-ml"),
    ], policy("preserve-alternatives"), 10_000);

    expect(decision.status).toBe("alternatives");
    expect(decision.value).toBeNull();
    expect(decision.alternatives).toEqual([
      { value: "finished", authority: "deterministic", authorities: ["deterministic"], evidenceIds: ["deterministic"] },
      { value: "dnf", authority: "validated-ml", authorities: ["validated-ml"], evidenceIds: ["ml"] },
    ]);
  });

  test("requires agreement from distinct authorities for consensus", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("deterministic", "finished", "deterministic"),
      claim("secondary", "finished", "secondary"),
      claim("ml", "dnf", "validated-ml"),
    ], policy("require-consensus"), 10_000);

    expect(decision.status).toBe("consensus");
    expect(decision.value).toBe("finished");
    expect(decision.acceptedEvidenceIds).toEqual(["deterministic", "secondary"]);
    expect(decision.alternatives).toHaveLength(2);
  });

  test("abstains on conflict while retaining every alternative and reason", () => {
    const decision = arbitrateRaceResultClaim(scope, [
      claim("deterministic", "finished", "deterministic"),
      claim("secondary", "dnf", "secondary"),
    ], policy("abstain-on-conflict"), 10_000);

    expect(decision.status).toBe("abstained");
    expect(decision.value).toBeNull();
    expect(decision.acceptedEvidenceIds).toEqual([]);
    expect(decision.alternatives.map((alternative) => alternative.value)).toEqual(["finished", "dnf"]);
    expect(decision.conflictReasons[0]).toContain("deterministic|secondary");
  });
});
