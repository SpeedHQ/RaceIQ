import { describe, expect, test } from "bun:test";
import { buildDeterministicLapFindings } from "../../server/findings/lap-findings";
import { adaptMetricsToFindings } from "../../server/findings/metrics-adapter";
import { publishFindingGeneration, subscribeFindingGeneration, type FindingGenerationPublishedEvent } from "../../server/findings/publication";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import type { EligibilityDecision } from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";
import { createFindingId } from "../../shared/racing/findings/identity";
import { FINDING_SCHEMA_VERSION, MAX_FINDING_EVIDENCE_REFS, type FindingRecord } from "../../shared/racing/findings/types";
import type { FindingGenerationReceipt } from "../../shared/racing/findings/types";
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
    measurements: [
      { id: "occurrences", type: "occurrence-count", value: 2, unit: "count", sampleCount: 300, confidence: "high", semanticIds: ["brake"], derivation: { id: "lap-insight", version: "2" } },
    ],
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
function finalizedLap(status: EligibilityDecision["status"]) {
  const provisional = summarize(qualityPackets(200));
  const finalized = finalizeLapQualityGeneration(provisional, `sha256:${"a".repeat(64)}`, { lapNumber: 1, rawByteOffset: 0, rawFrameCount: 200 });
  return {
    finalized,
    lap: {
      id: 1,
      sessionId: 1,
      lapNumber: 1,
      lapTime: 90,
      isValid: true,
      gameId: "acc" as const,
      quality: finalized.quality,
      eligibility: {
        ...finalized.eligibility,
        "corner-trace": { ...finalized.eligibility["corner-trace"], status },
      },
      qualityGeneration: finalized.quality.provenance.outputGeneration,
      telemetry: [{ TimestampMS: 0 }],
      fuelPerLap: 2.5,
      tyreWear: 1,
      createdAt: "2026-01-01T00:00:00Z",
    },
  };
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
    expect(validateFinding(missing).errors).toContainEqual(
      expect.objectContaining({
        path: "scope.gameId",
        code: "required",
      }),
    );

    const unknown = finding();
    Reflect.set(unknown.scope, "gameId", "unknown");
    unknown.id = createFindingId(unknown);
    expect(validateFinding(unknown).errors).toContainEqual(
      expect.objectContaining({
        path: "scope.gameId",
        code: "invalid-game",
      }),
    );
  });

  test("rejects available finding without available measurement or evidence", () => {
    const record = finding({ measurements: [], evidenceRefs: [] });
    record.id = createFindingId(record);
    const codes = validateFinding(record).errors.map((error) => error.code);
    expect(codes).toContain("missing-measurement");
    expect(codes).toContain("missing-evidence");
  });

  test("rejects evidence collections beyond fixed validation bound", () => {
    const record = finding({
      evidenceRefs: Array.from({ length: MAX_FINDING_EVIDENCE_REFS + 1 }, (_, index) => ({
        kind: "telemetry-range" as const,
        id: `range-${index}`,
        lapId: "lap-1",
        startFrameIndex: index * 2,
        endFrameIndex: index * 2,
      })),
    });

    expect(validateFinding(record).errors).toContainEqual(
      expect.objectContaining({
        path: "evidenceRefs",
        code: "too-many-evidence-references",
      }),
    );
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

  test("recomputes restricted insight identities and narrative links", () => {
    const { lap } = finalizedLap("ineligible");
    const bundle = buildDeterministicLapFindings(
      lap,
      [
        {
          id: "late-throttle",
          category: "driving",
          severity: "warning",
          label: "Late throttle",
          detail: "Throttle pickup followed rotation",
          frameIndices: [0],
        },
      ],
      { valid: true, reason: null },
      "analysis-1",
    );
    const insight = bundle.findings.find((candidate) => candidate.type === "lap-insight")!;

    expect(insight.status).toBe("indeterminate");
    expect(validateFinding(insight)).toEqual({ valid: true, errors: [] });
    expect(bundle.narratives[0]?.findingIds).toEqual([insight.id]);
  });

  test("makes stale, legacy, missing, and partial eligibility indeterminate", () => {
    const { finalized, lap } = finalizedLap("eligible");
    const unknownCornerTrace: EligibilityDecision = {
      ...finalized.eligibility["corner-trace"],
      status: "unknown",
      confidence: { level: "unknown", score: null },
      reasons: [],
    };
    const fixtures = [
      { name: "stale", lap: { ...lap, qualityStale: true } },
      {
        name: "legacy",
        lap: {
          ...lap,
          quality: {
            ...lap.quality,
            provenance: { ...lap.quality.provenance, policyVersion: "legacy" },
          },
        },
      },
      { name: "missing", lap: { ...lap, quality: undefined, eligibility: undefined } },
      {
        name: "partial",
        lap: {
          ...lap,
          eligibility: { "corner-trace": unknownCornerTrace } as unknown as NonNullable<typeof lap.eligibility>,
        },
      },
    ];

    for (const fixture of fixtures) {
      const bundle = buildDeterministicLapFindings(
        fixture.lap,
        [
          {
            id: "late-throttle",
            category: "driving",
            severity: "warning",
            label: "Late throttle",
            detail: "Throttle pickup followed rotation",
            frameIndices: [0],
          },
        ],
        { valid: true, reason: null },
        "analysis-1",
      );
      const insight = bundle.findings.find((candidate) => candidate.type === "lap-insight")!;

      expect([fixture.name, insight.status, insight.confidence]).toEqual([fixture.name, "indeterminate", "unknown"]);
      expect(validateFinding(insight)).toEqual({ valid: true, errors: [] });
    }
  });

  test("preserves eligible-with-warning policy evidence and low confidence", () => {
    const { finalized, lap } = finalizedLap("eligible_with_warning");
    const bundle = buildDeterministicLapFindings(
      lap,
      [
        {
          id: "late-throttle",
          category: "driving",
          severity: "warning",
          label: "Late throttle",
          detail: "Throttle pickup followed rotation",
          frameIndices: [0],
        },
      ],
      { valid: true, reason: null },
      "analysis-1",
    );
    const insight = bundle.findings.find((candidate) => candidate.type === "lap-insight")!;
    const fuelDecision: EligibilityDecision = {
      ...finalized.eligibility["fuel-burn"],
      status: "eligible_with_warning",
      reasons: [
        {
          code: "telemetry_gap_minor",
          severity: "warning",
          evidenceIds: [],
          timeRange: null,
          distanceRange: null,
          semanticIds: [],
        },
      ],
    };
    const fuel = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 1,
      lapId: 1,
      fuelPerLap: 2.5,
      quality: { valid: true, reason: null },
      finalizedPolicyDecisions: { "fuel-per-lap": fuelDecision },
    }).find((candidate) => candidate.type === "fuel-per-lap")!;

    for (const record of [insight, fuel]) {
      expect(record.status).toBe("available");
      expect(record.confidence).toBe("low");
      expect(record.qualityRefs).toHaveLength(1);
      expect(record.limitations[0]?.code).toContain("eligible_with_warning");
      expect(validateFinding(record)).toEqual({ valid: true, errors: [] });
    }
    expect(fuel.limitations.map((limitation) => limitation.code)).toContain("quality-policy-fuel-burn-reason-telemetry_gap_minor");
  });

  test("makes finite fuel and tyre metrics indeterminate without current policy decisions", () => {
    const { lap } = finalizedLap("eligible");
    const stale = buildDeterministicLapFindings(
      { ...lap, qualityStale: true },
      [],
      { valid: true, reason: null },
      "analysis-1",
    ).findings;
    const missing = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 1,
      lapId: 1,
      fuelPerLap: 2.5,
      tyreWear: 1,
      quality: { valid: true, reason: null },
      analysisGenerationId: "analysis-1",
    });
    const scenarios = [
      { name: "stale", records: stale, reasonCode: "quality_stale" },
      { name: "missing", records: missing, reasonCode: "quality_not_rebuilt" },
    ] as const;
    const metrics = [
      { type: "fuel-per-lap", policyId: "fuel-burn" },
      { type: "tyre-wear", policyId: "tire-analysis" },
    ] as const;

    for (const scenario of scenarios) {
      for (const metric of metrics) {
        const record = scenario.records.find((candidate) => candidate.type === metric.type)!;
        const limitationCodes = record.limitations.map((limitation) => limitation.code);

        expect([scenario.name, metric.type, record.status, record.confidence]).toEqual([
          scenario.name,
          metric.type,
          "indeterminate",
          "unknown",
        ]);
        expect(limitationCodes).toContain(`quality-policy-${metric.policyId}-unknown`);
        expect(limitationCodes).toContain(`quality-policy-${metric.policyId}-reason-${scenario.reasonCode}`);
        expect(validateFinding(record)).toEqual({ valid: true, errors: [] });
      }
    }
  });

  test("suppresses segment and consistency findings when recording quality is invalid", () => {
    const stats = {
      throttleAvg: 0.5,
      throttleMax: 1,
      fullThrottlePctDist: 0.2,
      brakeAvg: 0.1,
      brakeMax: 0.8,
      brakingPctDist: 0.1,
      brakeApplications: 1,
      steerAbsAvg: 0.1,
      steerAbsMax: 0.2,
      steeringSmoothness: 0.9,
      brakeOnDist: null,
      brakeOffDist: null,
      peakBrakeValue: 0.8,
      peakBrakeDist: null,
      fullThrottleDist: null,
      liftOffThrottleDist: null,
      minSpeed: 100,
      minSpeedDist: null,
      maxSpeed: 200,
      maxSpeedDist: null,
    };
    const records = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 1,
      lapId: 1,
      quality: { valid: false, reason: "too few telemetry packets" },
      segmentStats: [
        {
          name: "T1",
          type: "corner",
          number: 1,
          startFrac: 0,
          endFrac: 0.1,
          timeSec: 5,
          stats,
        },
      ],
      consistency: {
        perCorner: [],
        overall: { lateralSpreadM: 1, brakeVar: 0.1, throttleVar: 0.1, lowTrust: false },
      },
    }).filter((record) => record.type === "segment-performance" || record.type === "lap-consistency");

    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(record.status).toBe("indeterminate");
      expect(record.confidence).toBe("unknown");
      expect(record.qualityRefs).toHaveLength(1);
      expect(record.limitations.map((limitation) => limitation.code)).toContain("quality-rejected");
      expect(validateFinding(record)).toEqual({ valid: true, errors: [] });
    }
  });

  test("bounds selected-lap evidence while retaining cohort identity", () => {
    const selectedLapIds = Array.from({ length: MAX_FINDING_EVIDENCE_REFS + 1 }, (_, index) => index + 1);
    const records = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 1,
      lapId: 1,
      selectedLapIds,
      fuelPerLap: 2.5,
      tyreWear: 1,
      quality: { valid: true, reason: null },
    });

    for (const record of records) {
      expect(record.evidenceRefs).toHaveLength(MAX_FINDING_EVIDENCE_REFS);
      expect(record.evidenceRefs).toContainEqual(
        expect.objectContaining({
          kind: "measurement",
          measurementId: "selected-lap-cohort",
        }),
      );
      expect(record.limitations.map((limitation) => limitation.code)).toContain("evidence-truncated");
      expect(validateFinding(record)).toEqual({ valid: true, errors: [] });
    }
  });

  test("deep-freezes published receipt data without freezing caller input", () => {
    let published: FindingGenerationPublishedEvent | undefined;
    const dispose = subscribeFindingGeneration((event) => {
      published = event;
    });
    const receipt: FindingGenerationReceipt = {
      generationId: "generation-1",
      sourceId: "source-1",
      rule: { id: "rule-1", version: "1" },
      config: { mode: "original" },
      schemaVersion: FINDING_SCHEMA_VERSION,
      status: "current",
      findingCount: 0,
      availableCount: 0,
      unavailableCount: 0,
      indeterminateCount: 0,
      contentHash: "sha256:empty",
      createdAt: "2026-01-01T00:00:00Z",
    };
    try {
      publishFindingGeneration({ kind: "session", gameId: "acc", sessionId: "session-1" }, receipt, []);
    } finally {
      dispose();
    }

    expect(published).toBeDefined();
    expect(Object.isFrozen(published!.receipt)).toBe(true);
    expect(Object.isFrozen(published!.receipt.rule)).toBe(true);
    expect(Object.isFrozen(published!.receipt.config)).toBe(true);
    expect(Object.isFrozen(receipt.config)).toBe(false);
  });
});
