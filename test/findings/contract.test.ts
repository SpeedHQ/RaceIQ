import { describe, expect, test } from "bun:test";
import { createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, type FindingRecord } from "../../shared/racing/findings/types";
import { validateFinding } from "../../shared/racing/findings/validate";

function finding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  const record: FindingRecord = {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id: "pending",
    type: "braking-lockup",
    category: "driving",
    scope: { kind: "lap", gameId: "f1-2025", sessionId: "session-1", participantId: "driver-1", lapId: "lap-1" },
    status: "available",
    severity: "medium",
    confidence: "high",
    measurements: [{ id: "occurrences", type: "occurrence-count", value: 2, unit: "count", sampleCount: 300, confidence: "high", semanticIds: ["brake"], derivation: { id: "lap-insight", version: "2" } }],
    evidenceRefs: [{ kind: "telemetry-range", id: "range-10-20", lapId: "lap-1", startFrameIndex: 10, endFrameIndex: 20, channel: "brake", semanticIds: ["brake"] }],
    qualityRefs: [],
    limitations: [],
    rule: { id: "lockup-rule", version: "3", inputs: { threshold: 0.9 } },
    analysisGenerationId: "generation-1",
    ...overrides,
  };
  record.id = createFindingId(record);
  return record;
}

describe("finding contract validation", () => {
  test("accepts available finding with typed measurements and exact evidence", () => {
    const record = finding();
    expect(validateFinding(record)).toEqual({ valid: true, errors: [] });
    expect(record.evidenceRefs[0]).toMatchObject({ id: "range-10-20", lapId: "lap-1", startFrameIndex: 10, endFrameIndex: 20, channel: "brake" });
  });

  test("rejects missing or unregistered scope game", () => {
    const missing = finding();
    Reflect.deleteProperty(missing.scope, "gameId");
    missing.id = createFindingId(missing);
    expect(validateFinding(missing).errors).toContainEqual(expect.objectContaining({
      path: "scope.gameId",
      code: "required",
    }));

    const unknown = finding();
    Reflect.set(unknown.scope, "gameId", "unknown");
    unknown.id = createFindingId(unknown);
    expect(validateFinding(unknown).errors).toContainEqual(expect.objectContaining({
      path: "scope.gameId",
      code: "invalid-game",
    }));
  });

  test("rejects available finding without available measurement or evidence", () => {
    const record = finding({ measurements: [], evidenceRefs: [] });
    record.id = createFindingId(record);
    const codes = validateFinding(record).errors.map((error) => error.code);
    expect(codes).toContain("missing-measurement");
    expect(codes).toContain("missing-evidence");
  });

  test.each(["unavailable", "indeterminate"] as const)("requires stable limitation for %s status", (status) => {
    const invalid = finding({ status, measurements: [], evidenceRefs: [], limitations: [] });
    invalid.id = createFindingId(invalid);
    expect(validateFinding(invalid).errors.map((error) => error.code)).toContain("missing-limitation");
    const valid = finding({ status, measurements: [], evidenceRefs: [], limitations: [{ code: "insufficient-clean-laps", detail: "No comparable clean lap" }] });
    valid.id = createFindingId(valid);
    expect(validateFinding(valid).valid).toBe(true);
  });

  test("rejects null values without reason, non-canonical units, sample counts, and identity mismatch", () => {
    const record = finding({
      measurements: [{ id: "loss", type: "time-loss", value: null, unit: " seconds ", sampleCount: -1, confidence: "low", semanticIds: [], derivation: { id: "loss", version: "1" } }],
    });
    record.id = "wrong";
    const codes = validateFinding(record).errors.map((error) => error.code);
    expect(codes).toContain("missing-unavailable-reason");
    expect(codes).toContain("invalid-unit");
    expect(codes).toContain("invalid-sample-count");
    expect(codes).toContain("identity-mismatch");
  });
});
