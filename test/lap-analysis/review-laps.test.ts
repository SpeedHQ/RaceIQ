import { describe, test, expect } from "bun:test";
import { fastestLaps, selectEvaluationLaps, evaluationReasonLabel, REVIEW_LAP_CAP } from "../../shared/racing/laps/review-selection";
import {
  ELIGIBILITY_POLICY_VERSION,
  QUALITY_CONFIG_VERSION,
  QUALITY_SCHEMA_VERSION,
  type EligibilityDecision,
  type EligibilityDecisionSet,
  type EligibilityPolicyId,
  type LapQualitySummary,
  type QualityReasonCode,
} from "../../shared/racing/quality/contracts";

describe("fastestLaps", () => {
  const laps = [
    { id: 1, lapTime: 95.2 },
    { id: 2, lapTime: 92.1 },
    { id: 3, lapTime: 98.7 },
    { id: 4, lapTime: 91.0 },
    { id: 5, lapTime: 93.3 },
    { id: 6, lapTime: 90.5 },
    { id: 7, lapTime: 99.9 },
  ];

  test("returns the N fastest by lap time", () => {
    const out = fastestLaps(laps, 3);
    expect(out.map((l) => l.id)).toEqual([6, 4, 2]);
  });

  test("defaults to REVIEW_LAP_CAP", () => {
    expect(fastestLaps(laps).length).toBe(REVIEW_LAP_CAP);
    expect(REVIEW_LAP_CAP).toBe(5);
  });

  test("returns all when fewer than the cap, does not mutate input", () => {
    const few = [
      { id: 1, lapTime: 90 },
      { id: 2, lapTime: 91 },
    ];
    const snapshot = [...few];
    expect(fastestLaps(few).map((l) => l.id)).toEqual([1, 2]);
    expect(few).toEqual(snapshot);
  });
});

describe("selectEvaluationLaps", () => {
  const quality = {
    lifecycleState: "exact",
    facts: [],
    provenance: {
      schemaVersion: QUALITY_SCHEMA_VERSION,
      policyVersion: ELIGIBILITY_POLICY_VERSION,
      configurationVersion: QUALITY_CONFIG_VERSION,
      sourceGeneration: `sha256:${"a".repeat(64)}`,
      outputGeneration: `sha256:${"b".repeat(64)}`,
    },
  } as unknown as LapQualitySummary;
  const decision = (policyId: EligibilityPolicyId, status: EligibilityDecision["status"] = "eligible", code?: QualityReasonCode): EligibilityDecision => ({
    policyId,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    status,
    confidence: { level: status === "unknown" ? "unknown" : "high", score: status === "unknown" ? null : 1 },
    reasons: code ? [{ code, severity: "error", evidenceIds: [], timeRange: null, distanceRange: null, semanticIds: [] }] : [],
    evidenceIds: [],
  });
  const eligibility = (normalStatus: EligibilityDecision["status"] = "eligible", normalReason?: QualityReasonCode) =>
    ({
      "normal-pace": decision("normal-pace", normalStatus, normalReason),
      "corner-trace": decision("corner-trace"),
      "setup-analysis": decision("setup-analysis"),
    }) as unknown as EligibilityDecisionSet;
  const lap = (id: number, lapTime: number, over: Partial<Parameters<typeof selectEvaluationLaps>[0][number]> = {}) => {
    const built = {
      id,
      lapTime,
      isValid: true,
      invalidReason: null,
      phase: "flying" as const,
      conditions: [],
      paceEligibility: "eligible" as const,
      quality,
      eligibility: eligibility(),
      ...over,
    };
    if ((!built.isValid || built.paceEligibility !== "eligible") && over.eligibility === undefined) {
      built.eligibility = eligibility("ineligible", built.isValid ? "non_pace_classification" : "structurally_invalid");
    }
    return built;
  };

  test("chooses the fastest N clean laps, rest are slower-than-cap", () => {
    const laps = [lap(1, 95), lap(2, 91), lap(3, 93), lap(4, 94)];
    const sel = selectEvaluationLaps(laps, 2);
    expect(sel.chosen.map((l) => l.id)).toEqual([2, 3]);
    expect([...sel.chosenIds].sort()).toEqual([2, 3]);
    expect([...sel.cappedIds].sort()).toEqual([1, 4]);
    expect(sel.reasonById.get(2)).toBe("chosen");
    expect(sel.reasonById.get(1)).toBe("slower-than-cap");
  });

  test("manual exclusion wins over every other reason", () => {
    const laps = [lap(1, 90, { isValid: false, experimentExcluded: true, experimentExcludedSource: "manual" }), lap(2, 92), lap(3, 93), lap(4, 94)];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(1)).toBe("manual");
    expect(sel.chosenIds.has(1)).toBe(false);
  });

  test("a manual source that is not excluded stays a candidate", () => {
    const laps = [lap(1, 90, { experimentExcluded: false, experimentExcludedSource: "manual" }), lap(2, 91), lap(3, 92)];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(1)).toBe("chosen");
  });

  test("non-positive time and policy-rejected laps are ineligible", () => {
    const laps = [
      lap(2, 90, { isValid: false }),
      lap(3, 0, { eligibility: eligibility("ineligible", "structurally_invalid") }),
      lap(4, 90, { phase: "in", paceEligibility: "excluded" }),
      lap(5, 94),
      lap(6, 95),
      lap(7, 96),
    ];
    const sel = selectEvaluationLaps(laps);
    expect(sel.reasonById.get(2)).toBe("non-pace");
    expect(sel.reasonById.get(3)).toBe("invalid");
    expect(sel.reasonById.get(4)).toBe("non-pace");
    expect(sel.rejectionDecisionById.get(2)?.policyId).toBe("normal-pace");
    expect(sel.reasonCodesById.get(2)).toEqual(["structurally_invalid"]);
    expect(sel.chosen.map((l) => l.id)).toEqual([5, 6, 7]);
    expect(sel.cappedIds.size).toBe(0);
  });

  test("a capped lap already stamped by the auto pass reports source auto", () => {
    const laps = [lap(1, 90), lap(2, 90.5, { experimentExcluded: true, experimentExcludedSource: "auto" }), lap(3, 91)];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.reasonById.get(2)).toBe("auto");
    expect(sel.cappedIds.has(2)).toBe(true);
  });

  test("auto stamping never keeps a lap out of the chosen set", () => {
    // Stale auto-exclude state must lose to a fresh fastest-N ranking.
    const laps = [lap(1, 90, { experimentExcluded: true, experimentExcludedSource: "auto" }), lap(2, 91), lap(3, 92)];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.chosen.map((l) => l.id)).toEqual([1]);
    expect(sel.reasonById.get(1)).toBe("chosen");
  });

  test("every lap gets exactly one reason", () => {
    const laps = [lap(1, 90), lap(2, 91, { isValid: false }), lap(3, 92), lap(4, 93)];
    const sel = selectEvaluationLaps(laps, 1);
    expect(sel.reasonById.size).toBe(laps.length);
    for (const l of laps) expect(evaluationReasonLabel(sel.reasonById.get(l.id)!)).toBeTruthy();
  });

  test("exposes exact policy decision and machine-readable rejection reasons", () => {
    const laps = [lap(1, 90, { eligibility: eligibility("ineligible", "traffic_context") }), lap(2, 91), lap(3, 92), lap(4, 93)];
    const sel = selectEvaluationLaps(laps);
    expect(sel.rejectionDecisionById.get(1)?.policyId).toBe("normal-pace");
    expect(sel.reasonCodesById.get(1)).toEqual(["traffic_context"]);
    expect(sel.setupDecision.status).toBe("eligible");
  });

  test("empty input yields an empty selection", () => {
    const sel = selectEvaluationLaps([]);
    expect(sel.chosen).toEqual([]);
    expect(sel.reasonById.size).toBe(0);
  });
});
