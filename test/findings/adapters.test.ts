import { describe, expect, test } from "bun:test";

import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { validateFinding } from "../../shared/racing/findings/validate";
import { adaptComparisonToFindings } from "../../server/findings/comparison-adapter";
import { adaptLapInsightsToFindingBundle, adaptLapInsightsToFindings } from "../../server/findings/lap-adapter";
import { adaptMetricsToFindings } from "../../server/findings/metrics-adapter";
import type { ComparisonResult } from "../../server/lap-analysis/comparison";
import { generateExport } from "../../server/lap-analysis/report";
import { buildDeterministicLapFindings } from "../../server/findings/lap-findings";

const insight: LapInsight = {
  id: "wheel-lock",
  category: "driving",
  severity: "warning",
  label: "Wheel lock",
  detail: "front wheel locked",
  frameIndices: [12, 18],
  timeLossS: 0.24,
};

function comparisonResult(deltaSeconds = -0.25): ComparisonResult {
  const trace = {
    speed: [100, 90], throttle: [1, 0], brake: [0, 1], steer: [0, 0], rpm: [7000, 6000],
    gear: [4, 3], posX: [0, 1], posZ: [0, 1], elapsedTime: [0, 1], tireWear: [0, 0],
    fuel: [20, 19], sourceIndices: [4, 9],
  };
  return {
    distances: [0, 1],
    lapA: trace,
    lapB: { ...trace, sourceIndices: [6, 11] },
    timeDelta: [0, deltaSeconds],
    cornerDeltas: [{
      label: "Turn 1",
      deltaSeconds,
      timeA: 1,
      timeB: 1 - deltaSeconds,
      distanceStart: 0,
      distanceEnd: 1,
      alignedStartIndex: 0,
      alignedEndIndex: 1,
      sourceStartIndexA: 4,
      sourceEndIndexA: 9,
      sourceStartIndexB: 6,
      sourceEndIndexB: 11,
    }],
  };
}

function reportPacket(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: "acc",
    CarClass: 1,
    DrivetrainType: 0,
    CarOrdinal: 1,
    CarPerformanceIndex: 700,
    VelocityX: 20,
    VelocityY: 0,
    VelocityZ: 0,
    CurrentEngineRpm: 6000,
    Accel: 128,
    Brake: 0,
    TireTempFL: 80,
    TireTempFR: 81,
    TireTempRL: 82,
    TireTempRR: 83,
    SuspensionTravelMFL: 0.1,
    SuspensionTravelMFR: 0.1,
    SuspensionTravelMRL: 0.1,
    SuspensionTravelMRR: 0.1,
    Gear: 3,
    TireWearFL: 0.1,
    TireWearFR: 0.11,
    TireWearRL: 0.12,
    TireWearRR: 0.13,
    DistanceTraveled: 0,
    TimestampMS: 0,
    ...overrides,
  } as TelemetryPacket;
}

describe("finding adapters", () => {
  test("quality rejection suppresses insight confidence and preserves exact frames", () => {
    const findings = adaptLapInsightsToFindings({
      sessionId: 7,
      lapId: 41,
      insights: [insight],
      quality: { valid: false, reason: "too few telemetry packets" },
      analysisGenerationId: "generation-1",
      ruleVersion: "3",
    });

    const adapted = findings.find((finding) => finding.type === "lap-insight");
    expect(adapted?.status).toBe("indeterminate");
    expect(adapted?.confidence).toBe("unknown");
    expect(adapted?.measurements.find((measurement) => measurement.type === "occurrence-count")?.value).toBe(2);
    expect(adapted?.limitations[0]?.code).toBe("quality-suppressed");
    expect(adapted?.evidenceRefs.filter((reference) => reference.kind === "telemetry-range")).toEqual([
      expect.objectContaining({ startFrameIndex: 12, endFrameIndex: 12 }),
      expect.objectContaining({ startFrameIndex: 18, endFrameIndex: 18 }),
    ]);
    expect(findings.some((finding) => finding.type === "lap-quality")).toBe(true);
    expect(findings.every((finding) => validateFinding(finding).valid)).toBe(true);
  });

  test("keeps insight detail as linked narrative without changing finding identity", () => {
    const original = adaptLapInsightsToFindingBundle({
      sessionId: 7,
      lapId: 41,
      insights: [{ ...insight, id: "brake-drag", detail: "Release brake fully before throttle." }],
      analysisGenerationId: "generation-1",
    });
    const reworded = adaptLapInsightsToFindingBundle({
      sessionId: 7,
      lapId: 41,
      insights: [{ ...insight, id: "brake-drag", detail: "Avoid dragging brake after turn-in." }],
      analysisGenerationId: "generation-1",
    });

    const findingId = original.findings[0]?.id;
    expect(findingId).toBe(reworded.findings[0]?.id);
    expect(original.narratives).toEqual([expect.objectContaining({
      findingIds: [findingId],
      text: "Release brake fully before throttle.",
      generator: "lap-insight-adapter",
      generationId: "generation-1",
    })]);
    expect(original.recommendations).toEqual([]);
  });

  test("undefined fuel and tyre aggregates remain explicit unavailable values", () => {
    const findings = adaptMetricsToFindings({ sessionId: 7, lapId: 41 });

    expect(findings.map((finding) => finding.type)).toEqual(["fuel-per-lap", "tyre-wear"]);
    for (const finding of findings) {
      expect(finding.status).toBe("unavailable");
      expect(finding.measurements[0].value).toBeNull();
      expect(finding.measurements[0].sampleCount).toBe(0);
      expect(finding.limitations[0].code).toContain("source-unavailable");
    }
    expect(findings.every((finding) => validateFinding(finding).valid)).toBe(true);
  });

  test("rejected lap quality makes fuel and tyre metrics indeterminate", () => {
    const findings = adaptMetricsToFindings({
      sessionId: 7,
      lapId: 41,
      fuelPerLap: 2.4,
      tyreWear: 13,
      quality: { valid: false, reason: "telemetry distance too short" },
    });

    for (const finding of findings) {
      expect(finding.status).toBe("indeterminate");
      expect(finding.confidence).toBe("unknown");
      expect(finding.measurements[0]?.confidence).toBe("unknown");
      expect(finding.limitations).toContainEqual(expect.objectContaining({
        code: "quality-rejected",
        detail: "telemetry distance too short",
      }));
      expect(finding.qualityRefs).toEqual([
        expect.objectContaining({
          kind: "quality-decision",
          id: "quality:41:suppressed:distance-too-short",
        }),
      ]);
    }
    expect(findings.every((finding) => validateFinding(finding).valid)).toBe(true);
  });

  test("accepted lap quality preserves available metric findings", () => {
    const findings = adaptMetricsToFindings({
      sessionId: 7,
      lapId: 41,
      fuelPerLap: 2.4,
      tyreWear: 13,
      quality: { valid: true, reason: null },
    });

    expect(findings.every((finding) =>
      finding.status === "available" &&
      finding.confidence === "high" &&
      finding.qualityRefs.length === 0
    )).toBe(true);
    expect(findings.every((finding) => validateFinding(finding).valid)).toBe(true);
  });

  test("comparison preserves A-minus-B sign and reference identity", () => {
    const result = comparisonResult(-0.25);
    const [finding] = adaptComparisonToFindings({
      sessionId: 7,
      sessionAId: 7,
      sessionBId: 9,
      lapAId: 41,
      lapBId: 52,
      result,
      referenceId: "lap:52",
      referenceSelectionReason: "selected fastest valid lap",
    });
    const [otherReference] = adaptComparisonToFindings({
      sessionId: 7,
      sessionAId: 7,
      sessionBId: 9,
      lapAId: 41,
      lapBId: 52,
      result,
      referenceId: "lap:99",
      referenceSelectionReason: "selected representative lap",
    });

    expect(finding.measurements.find((measurement) => measurement.type === "lap-a-minus-lap-b-time-delta")?.value).toBe(-0.25);
    expect(finding.comparisonReference).toEqual(expect.objectContaining({
      id: "lap:52",
      selectionReason: "selected fastest valid lap",
    }));
    expect(finding.evidenceRefs).toContainEqual(expect.objectContaining({ kind: "lap", lapId: "52", sessionId: "9" }));
    expect(otherReference.id).not.toBe(finding.id);
    expect(validateFinding(finding).valid).toBe(true);
  });

  test("lap resource helper emits deterministic findings without raw packets", () => {
    const bundle = buildDeterministicLapFindings({
      id: 41,
      sessionId: 7,
      lapNumber: 2,
      lapTime: 90,
      isValid: true,
      createdAt: "2026-08-21T00:00:00.000Z",
      telemetry: [{ TimestampMS: 100 }, { TimestampMS: 200 }],
    }, [insight], { valid: true, reason: null });

    expect(bundle.findings.some((finding) => finding.type === "lap-insight")).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("VelocityX");
    expect(JSON.stringify(bundle)).not.toContain("packets");
  });

  test("lap findings service applies rejected quality to every metric finding", () => {
    const bundle = buildDeterministicLapFindings({
      id: 41,
      sessionId: 7,
      lapNumber: 2,
      lapTime: 90,
      isValid: false,
      createdAt: "2026-08-21T00:00:00.000Z",
      fuelPerLap: 2.4,
      tyreWear: 13,
      telemetry: [{ TimestampMS: 100 }],
    }, [insight], { valid: false, reason: "too few telemetry packets" });

    const metrics = bundle.findings.filter((finding) =>
      finding.type === "fuel-per-lap" || finding.type === "tyre-wear"
    );
    expect(metrics).toHaveLength(2);
    expect(metrics.every((finding) =>
      finding.status === "indeterminate" &&
      finding.confidence === "unknown" &&
      finding.limitations.some((limitation) => limitation.code === "quality-rejected")
    )).toBe(true);
    expect(bundle.narratives).toEqual([
      expect.objectContaining({
        findingIds: [expect.any(String)],
        text: insight.detail,
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
    ]);
    expect(bundle.recommendations).toEqual([]);
  });

  test("lap export renders deterministic findings section", () => {
    const packets = [reportPacket(), reportPacket({ DistanceTraveled: 100, TimestampMS: 1000 })];
    const findings = adaptMetricsToFindings({ sessionId: 7, lapId: 41, fuelPerLap: 2.4, tyreWear: 13 });
    const lap = { lapNumber: 2, lapTime: 90, isValid: true, carOrdinal: 1, trackOrdinal: 2 };

    const first = generateExport(lap, packets, "metric", undefined, findings);
    const second = generateExport(lap, packets, "metric", undefined, [...findings].reverse());
    expect(first).toContain("--- Deterministic Findings ---");
    expect(first).toContain("Fuel used per lap");
    expect(second).toBe(first);
    const rejected = generateExport(
      lap,
      packets,
      "metric",
      undefined,
      adaptMetricsToFindings({
        sessionId: 7,
        lapId: 41,
        fuelPerLap: 2.4,
        tyreWear: 13,
        quality: { valid: false, reason: "telemetry distance too short" },
      }),
    );
    expect(rejected).toContain("- Status: indeterminate");
    expect(rejected).toContain("quality-rejected: telemetry distance too short");
  });
});
