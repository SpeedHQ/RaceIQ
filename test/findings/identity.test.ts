import { describe, expect, test } from "bun:test";
import { assertNoFindingConflicts, canonicalJson, createFindingId, findFindingConflicts } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, type FindingRecord } from "../../shared/racing/findings/types";

function record(lapId = "lap-1"): FindingRecord {
  const value: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type: "late-braking",
    category: "driving",
    scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-1", participantId: "driver-1", lapId },
    status: "available",
    severity: "low",
    confidence: "medium",
    measurements: [{ id: "loss", type: "time-loss", value: 0.2, unit: "s", sampleCount: 20, confidence: "medium", semanticIds: ["speed", "brake"], derivation: { id: "corner-delta", version: "1" } }],
    evidenceRefs: [{ kind: "lap", id: lapId, lapId }, { kind: "event", id: `event-${lapId}`, eventId: `event-${lapId}` }],
    qualityRefs: [],
    limitations: [],
    rule: { id: "braking", version: "4", inputs: { thresholds: { z: 2, a: 1 } } },
    analysisGenerationId: "generation-1",
    title: "Brake later",
  };
  value.id = createFindingId(value);
  return value;
}

describe("finding identity", () => {
  test("canonical JSON ignores object key order", () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test("distinguishes sparse arrays from explicit null entries", () => {
    const sparse = Array<unknown>(1);
    expect(() => canonicalJson(sparse)).toThrow("holes or undefined");
    expect(() => canonicalJson([undefined])).toThrow("holes or undefined");
    expect(canonicalJson([null])).toBe("[null]");
  });

  test("ignores evidence insertion order and prose", () => {
    const first = record();
    const permuted = { ...first, title: "Different prose", evidenceRefs: [...first.evidenceRefs].reverse() };
    expect(createFindingId(permuted)).toBe(first.id);
    expect(findFindingConflicts([first, permuted])).toEqual([]);
  });

  test("changes for game, scope, evidence, generation, rule version, or comparison reference", () => {
    const base = record();
    const variants: FindingRecord[] = [
      { ...base, scope: { ...base.scope, gameId: "acc" } },
      { ...base, scope: { ...base.scope, lapId: "lap-2" } },
      { ...base, evidenceRefs: [{ kind: "lap", id: "lap-2", lapId: "lap-2" }] },
      { ...base, analysisGenerationId: "generation-2" },
      { ...base, rule: { ...base.rule, version: "5" } },
      { ...base, comparisonReference: { id: "reference-1", kind: "best-lap", selectionReason: "Fastest clean lap", evidenceRefs: [{ kind: "lap", id: "lap-best", lapId: "lap-best" }] } },
    ];
    for (const variant of variants) expect(createFindingId(variant)).not.toBe(base.id);
  });

  test("rejects materially different records sharing one ID", () => {
    const first = record();
    const conflicting = { ...record(), measurements: [{ ...record().measurements[0], value: 0.8 }] };
    conflicting.id = first.id;
    expect(findFindingConflicts([first, conflicting])).toEqual([{ id: first.id, firstIndex: 0, conflictingIndex: 1 }]);
    expect(() => assertNoFindingConflicts([first, conflicting])).toThrow("Conflicting finding records share an ID");
  });
});
