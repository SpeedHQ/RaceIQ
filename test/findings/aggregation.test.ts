import { describe, expect, test } from "bun:test";
import { aggregateFindings } from "../../shared/racing/findings/aggregate";
import { createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, MAX_FINDING_EVIDENCE_REFS, type FindingRecord } from "../../shared/racing/findings/types";
import { validateFinding } from "../../shared/racing/findings/validate";

function lapFinding(lapId: string, loss: number, recurring: boolean, overrides: Partial<FindingRecord> = {}): FindingRecord {
  const value: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type: "corner-time-loss",
    category: "pace",
    scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-1", participantId: "driver-1", cornerId: "turn-1", lapId },
    status: "available",
    severity: "medium",
    confidence: "medium",
    measurements: [
      { id: "loss", type: "time-loss", value: loss, unit: "s", sampleCount: 10, confidence: "medium", semanticIds: ["speed"], derivation: { id: "comparison", version: "1" } },
      { id: "recurring", type: "recurring", value: recurring, unit: "boolean", sampleCount: 1, confidence: "medium", semanticIds: [], derivation: { id: "comparison", version: "1" } },
    ],
    evidenceRefs: [
      { kind: "lap", id: lapId, lapId },
      { kind: "telemetry-range", id: `range-${lapId}`, lapId, startFrameIndex: 10, endFrameIndex: 20, channel: "speed" },
    ],
    qualityRefs: [],
    limitations: [],
    rule: { id: "corner-loss", version: "2", inputs: { carId: "car-1", trackId: "track-1", context: "dry" } },
    analysisGenerationId: "generation-1",
    ...overrides,
  };
  value.id = createFindingId(value);
  return value;
}

const target = { kind: "corner", gameId: "f1-2025", sessionId: "session-1", participantId: "driver-1", cornerId: "turn-1" } as const;

describe("finding aggregation", () => {
  test("uses median, majority, observed frequency, and representative evidence", () => {
    const inputs = [lapFinding("lap-1", 1, true), lapFinding("lap-2", 100, false), lapFinding("lap-3", 2, true)];
    const result = aggregateFindings(inputs, { targetScope: target, evaluatedLapIds: ["lap-1", "lap-2", "lap-3", "lap-4"] });
    expect(result.status).toBe("aggregated");
    if (result.status !== "aggregated") return;
    expect(result.frequency).toBe(0.75);
    expect(result.contributingLapIds).toEqual(["lap-1", "lap-2", "lap-3"]);
    expect(result.finding.measurements.find((measurement) => measurement.type === "time-loss")?.value).toBe(2);
    expect(result.finding.measurements.find((measurement) => measurement.type === "recurring")?.value).toBe(true);
    expect(result.finding.measurements.find((measurement) => measurement.type === "occurrence-count")?.value).toBe(3);
    expect(result.examples.bestFindingId).toBe(inputs[0].id);
    expect(result.examples.worstFindingId).toBe(inputs[1].id);
    expect(result.examples.typicalFindingId).toBe(inputs[2].id);
    expect(
      result.finding.evidenceRefs
        .filter((reference) => reference.kind === "lap")
        .map((reference) => reference.id)
        .sort(),
    ).toEqual(["lap-1", "lap-2", "lap-3"]);
  });

  test("refuses cross-game, session, participant, and supplied context", () => {
    const base = lapFinding("lap-1", 1, true);
    const game = lapFinding("lap-2", 2, true, { scope: { kind: "lap", gameId: "acc", sessionId: "session-1", participantId: "driver-1", cornerId: "turn-1", lapId: "lap-2" } });
    expect(aggregateFindings([base, game], { targetScope: target })).toMatchObject({ reason: "incompatible-scope" });
    const session = lapFinding("lap-2", 2, true, { scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-2", participantId: "driver-1", cornerId: "turn-1", lapId: "lap-2" } });
    expect(aggregateFindings([base, session], { targetScope: target })).toMatchObject({ reason: "incompatible-scope" });
    const participant = lapFinding("lap-2", 2, true, { scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-1", participantId: "driver-2", cornerId: "turn-1", lapId: "lap-2" } });
    expect(aggregateFindings([base, participant], { targetScope: target })).toMatchObject({ reason: "incompatible-scope" });
    const context = lapFinding("lap-2", 2, true, { rule: { ...base.rule, inputs: { ...base.rule.inputs, trackId: "track-2" } } });
    expect(aggregateFindings([base, context], { targetScope: target })).toMatchObject({ reason: "incompatible-context" });
  });

  test("refuses incompatible generation, rule version, and comparison reference", () => {
    const base = lapFinding("lap-1", 1, true);
    expect(aggregateFindings([base, lapFinding("lap-2", 2, true, { analysisGenerationId: "generation-2" })], { targetScope: target })).toMatchObject({ reason: "incompatible-generation" });
    expect(aggregateFindings([base, lapFinding("lap-2", 2, true, { rule: { ...base.rule, version: "3" } })], { targetScope: target })).toMatchObject({ reason: "incompatible-rule" });
    const referenced = lapFinding("lap-2", 2, true, {
      comparisonReference: { id: "ref-1", kind: "clean-lap", selectionReason: "Clean", evidenceRefs: [{ kind: "lap", id: "lap-ref", lapId: "lap-ref" }] },
    });
    expect(aggregateFindings([base, referenced], { targetScope: target })).toMatchObject({ reason: "incompatible-reference" });
  });

  test("refuses missing or duplicate measurement groups", () => {
    const base = lapFinding("lap-1", 1, true);
    const complete = lapFinding("lap-2", 2, false);
    const missing = lapFinding("lap-2", 2, false, {
      measurements: [complete.measurements[0]!],
    });
    expect(aggregateFindings([base, missing], { targetScope: target })).toMatchObject({
      status: "not-aggregated",
      reason: "incompatible-measurements",
    });

    const duplicate = lapFinding("lap-2", 2, false, {
      measurements: [...complete.measurements, { ...complete.measurements[0]!, id: "duplicate-loss" }],
    });
    expect(aggregateFindings([base, duplicate], { targetScope: target })).toMatchObject({
      status: "not-aggregated",
      reason: "incompatible-measurements",
    });
  });

  test("does not merge one-off finding below persistence threshold", () => {
    const result = aggregateFindings([lapFinding("lap-1", 1, true)], { targetScope: target, minimumOccurrences: 2 });
    expect(result).toMatchObject({ status: "not-aggregated", reason: "below-persistence-threshold" });
  });

  test("bounds representative evidence for long-session aggregation", () => {
    const inputs = Array.from({ length: MAX_FINDING_EVIDENCE_REFS + 1 }, (_, index) => lapFinding(`lap-${index + 1}`, index + 1, true));
    const result = aggregateFindings(inputs, {
      targetScope: target,
      evaluatedLapIds: inputs.map((input) => input.scope.lapId!),
    });

    expect(result.status).toBe("aggregated");
    if (result.status !== "aggregated") return;
    expect(result.finding.evidenceRefs).toHaveLength(MAX_FINDING_EVIDENCE_REFS);
    expect(result.finding.evidenceRefs).toContainEqual(
      expect.objectContaining({
        kind: "measurement",
        measurementId: "aggregate-evidence-cohort",
      }),
    );
    expect(result.finding.limitations.map((limitation) => limitation.code)).toContain("evidence-truncated");
    expect(validateFinding(result.finding)).toEqual({ valid: true, errors: [] });
  });
});
