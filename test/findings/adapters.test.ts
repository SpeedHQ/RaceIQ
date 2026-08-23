import { describe, expect, test } from "bun:test";

import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import { validateFinding } from "../../shared/racing/findings/validate";
import { adaptComparisonToFindings } from "../../server/findings/comparison-adapter";
import { adaptLapInsightsToFindingBundle, adaptLapInsightsToFindings } from "../../server/findings/lap-adapter";
import { adaptMetricsToFindings } from "../../server/findings/metrics-adapter";
import type { ComparisonResult } from "../../server/lap-analysis/comparison";
import { generateExport } from "../../server/lap-analysis/report";
import { buildDeterministicLapFindings } from "../../server/findings/lap-findings";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const insight: LapInsight = {
  id: "wheel-lock",
  category: "driving",
  severity: "warning",
  label: "Wheel lock",
  detail: "front wheel locked",
  frameIndices: [12, 18],
  timeLossS: 0.24,
};
const reportQuality = finalizeLapQualityGeneration(summarize(qualityPackets(200)), `sha256:${"a".repeat(64)}`, {
  lapNumber: 2,
  rawByteOffset: null,
  rawFrameCount: 200,
});
function semanticSamples(count: number): SemanticTelemetrySample[] {
  return Array.from({ length: count }, (_, index) => ({
    sequence: String(index),
    observedAtMs: index * 100,
    values: {},
  }));
}

function comparisonResult(deltaSeconds = -0.25): ComparisonResult {
  const trace = {
    speed: [100, 90],
    throttle: [1, 0],
    brake: [0, 1],
    steer: [0, 0],
    rpm: [7000, 6000],
    gear: [4, 3],
    posX: [0, 1],
    posZ: [0, 1],
    elapsedTime: [0, 1],
    tireWear: [0, 0],
    fuel: [20, 19],
    sourceIndices: [4, 9],
  };
  return {
    distances: [0, 1],
    lapA: trace,
    lapB: { ...trace, sourceIndices: [6, 11] },
    timeDelta: [0, deltaSeconds],
    cornerDeltas: [
      {
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
      },
    ],
  };
}

function reportSample(distanceM: number, observedAtMs: number): SemanticTelemetrySample {
  return {
    sequence: String(observedAtMs),
    observedAtMs,
    values: {
      "motion.velocity-x": 20,
      "motion.velocity-y": 0,
      "motion.velocity-z": 0,
      "engine.current-engine-rpm": 6000,
      "inputs.accel": 128,
      "inputs.brake": 0,
      "inputs.gear": 3,
      "tire.temperature.average": [80, 81, 82, 83],
      "suspension.suspension-travel-m": [0.1, 0.1, 0.1, 0.1],
      "tires.tire-wear": [0.1, 0.11, 0.12, 0.13],
      "timing.distance-traveled": distanceM,
    },
  };
}

describe("finding adapters", () => {
  test("quality rejection suppresses insight confidence and preserves exact frames", () => {
    const findings = adaptLapInsightsToFindings({
      sessionId: 7,
      gameId: "acc",
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

  test("bounds large frame evidence while preserving total occurrences and deterministic identity", () => {
    const sparseFrames = Array.from({ length: 1_000 }, (_, index) => index * 2);
    const context = {
      sessionId: 7,
      gameId: "acc" as const,
      lapId: 41,
      analysisGenerationId: "generation-large",
    };
    const forward = adaptLapInsightsToFindings({
      ...context,
      insights: [{ ...insight, frameIndices: sparseFrames }],
    })[0]!;
    const reversed = adaptLapInsightsToFindings({
      ...context,
      insights: [{ ...insight, frameIndices: [...sparseFrames].reverse() }],
    })[0]!;
    const ranges = forward.evidenceRefs.filter((reference) => reference.kind === "telemetry-range");

    expect(ranges).toHaveLength(32);
    expect(ranges[0]).toMatchObject({ startFrameIndex: 0, endFrameIndex: 0 });
    expect(ranges[31]).toMatchObject({ startFrameIndex: 62, endFrameIndex: 62 });
    expect(forward.measurements.find((measurement) => measurement.type === "occurrence-count")).toMatchObject({
      value: 1_000,
      sampleCount: 1_000,
    });
    expect(forward.limitations).toContainEqual({
      code: "evidence-truncated",
      detail: "Retained 32 of 1000 contiguous telemetry ranges for 1000 occurrences; 968 ranges omitted.",
    });
    expect(reversed.id).toBe(forward.id);
    expect(reversed.evidenceRefs).toEqual(forward.evidenceRefs);
    expect(validateFinding(forward).valid).toBe(true);
  });

  test("merges large contiguous frame evidence without losing exact coverage", () => {
    const finding = adaptLapInsightsToFindings({
      sessionId: 7,
      gameId: "acc",
      lapId: 41,
      insights: [{ ...insight, frameIndices: Array.from({ length: 1_000 }, (_, index) => index) }],
      analysisGenerationId: "generation-contiguous",
    })[0]!;

    expect(finding.evidenceRefs.filter((reference) => reference.kind === "telemetry-range")).toEqual([expect.objectContaining({ startFrameIndex: 0, endFrameIndex: 999 })]);
    expect(finding.limitations).not.toContainEqual(expect.objectContaining({ code: "evidence-truncated" }));
    expect(finding.measurements.find((measurement) => measurement.type === "occurrence-count")?.value).toBe(1_000);
  });

  test("keeps insight detail as linked narrative without changing finding identity", () => {
    const original = adaptLapInsightsToFindingBundle({
      sessionId: 7,
      gameId: "acc",
      lapId: 41,
      insights: [{ ...insight, id: "brake-drag", detail: "Release brake fully before throttle." }],
      analysisGenerationId: "generation-1",
    });
    const reworded = adaptLapInsightsToFindingBundle({
      sessionId: 7,
      gameId: "acc",
      lapId: 41,
      insights: [{ ...insight, id: "brake-drag", detail: "Avoid dragging brake after turn-in." }],
      analysisGenerationId: "generation-1",
    });

    const findingId = original.findings[0]?.id;
    expect(findingId).toBe(reworded.findings[0]?.id);
    expect(original.narratives).toEqual([
      expect.objectContaining({
        findingIds: [findingId],
        text: "Release brake fully before throttle.",
        generator: "lap-insight-adapter",
        generationId: "generation-1",
      }),
    ]);
    expect(original.recommendations).toEqual([]);
  });

  test("undefined fuel and tyre aggregates remain explicit unavailable values", () => {
    const findings = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 7,
      lapId: 41,
      quality: { valid: true, reason: null },
    });

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
      gameId: "acc",
      lapId: 41,
      fuelPerLap: 2.4,
      tyreWear: 13,
      quality: { valid: false, reason: "telemetry distance too short" },
    });

    for (const finding of findings) {
      expect(finding.status).toBe("indeterminate");
      expect(finding.confidence).toBe("unknown");
      expect(finding.measurements[0]?.confidence).toBe("unknown");
      expect(finding.limitations).toContainEqual(
        expect.objectContaining({
          code: "quality-rejected",
          detail: "telemetry distance too short",
        }),
      );
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
      gameId: "acc",
      lapId: 41,
      fuelPerLap: 2.4,
      tyreWear: 13,
      quality: { valid: true, reason: null },
    });

    expect(findings.every((finding) => finding.status === "available" && finding.confidence === "high" && finding.qualityRefs.length === 0)).toBe(true);
    expect(findings.every((finding) => validateFinding(finding).valid)).toBe(true);
  });

  test("comparison preserves A-minus-B sign and reference identity", () => {
    const result = comparisonResult(-0.25);
    const [finding] = adaptComparisonToFindings({
      sessionId: 7,
      gameId: "acc",
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
      gameId: "acc",
      sessionAId: 7,
      sessionBId: 9,
      lapAId: 41,
      lapBId: 52,
      result,
      referenceId: "lap:99",
      referenceSelectionReason: "selected representative lap",
    });

    expect(finding.measurements.find((measurement) => measurement.type === "lap-a-minus-lap-b-time-delta")?.value).toBe(-0.25);
    expect(finding.comparisonReference).toEqual(
      expect.objectContaining({
        id: "lap:52",
        selectionReason: "selected fastest valid lap",
      }),
    );
    expect(finding.evidenceRefs).toContainEqual(expect.objectContaining({ kind: "lap", lapId: "52", sessionId: "9" }));
    expect(finding.evidenceRefs.filter((reference) => reference.kind === "telemetry-range")).toEqual([
      expect.objectContaining({ lapId: "41", sessionId: "7", startFrameIndex: 4, endFrameIndex: 9 }),
      expect.objectContaining({ lapId: "52", sessionId: "9", startFrameIndex: 6, endFrameIndex: 11 }),
    ]);
    expect(otherReference.id).not.toBe(finding.id);
    expect(validateFinding(finding).valid).toBe(true);
  });

  test("lap resource helper emits deterministic findings without raw packets", () => {
    const bundle = buildDeterministicLapFindings(
      {
        id: 41,
        sessionId: 7,
        gameId: "acc",
        lapNumber: 2,
        lapTime: 90,
        isValid: true,
        createdAt: "2026-08-21T00:00:00.000Z",
        quality: reportQuality.quality,
        telemetry: semanticSamples(2),
      },
      [insight],
      { valid: true, reason: null },
      "analysis-generation-1",
    );

    expect(bundle.findings.some((finding) => finding.type === "lap-insight")).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain("VelocityX");
    expect(JSON.stringify(bundle)).not.toContain("packets");
  });

  test("lap findings service applies rejected quality to every metric finding", () => {
    const bundle = buildDeterministicLapFindings(
      {
        id: 41,
        sessionId: 7,
        gameId: "acc",
        lapNumber: 2,
        lapTime: 90,
        isValid: false,
        createdAt: "2026-08-21T00:00:00.000Z",
        fuelPerLap: 2.4,
        tyreWear: 13,
        quality: reportQuality.quality,
        telemetry: semanticSamples(1),
      },
      [insight],
      { valid: false, reason: "too few telemetry packets" },
      "analysis-generation-1",
    );

    const metrics = bundle.findings.filter((finding) => finding.type === "fuel-per-lap" || finding.type === "tyre-wear");
    expect(metrics).toHaveLength(2);
    expect(metrics.every((finding) => finding.status === "indeterminate" && finding.confidence === "unknown" && finding.limitations.some((limitation) => limitation.code === "quality-rejected"))).toBe(
      true,
    );
    expect(bundle.narratives).toEqual([
      expect.objectContaining({
        findingIds: [expect.any(String)],
        text: insight.detail,
        createdAt: "2026-08-21T00:00:00.000Z",
      }),
    ]);
    expect(bundle.recommendations).toEqual([]);
  });

  test("finalized policies restrict fuel, tire, and insight findings", () => {
    const ineligible = (policy: "corner-trace" | "fuel-burn" | "tire-analysis") => ({
      ...reportQuality.eligibility[policy],
      status: "ineligible" as const,
    });
    const bundle = buildDeterministicLapFindings(
      {
        id: 41,
        sessionId: 7,
        gameId: "iracing",
        lapNumber: 2,
        lapTime: 90,
        isValid: true,
        createdAt: "2026-08-21T00:00:00.000Z",
        fuelPerLap: 2.4,
        tyreWear: 13,
        telemetry: semanticSamples(200),
        quality: reportQuality.quality,
        eligibility: {
          ...reportQuality.eligibility,
          "corner-trace": ineligible("corner-trace"),
          "fuel-burn": ineligible("fuel-burn"),
          "tire-analysis": ineligible("tire-analysis"),
        },
        qualityGeneration: reportQuality.quality.provenance.outputGeneration,
        qualityStale: false,
      },
      [insight],
      { valid: true, reason: null },
      "analysis-generation-1",
    );

    const restricted = bundle.findings.filter((finding) => finding.type === "lap-insight" || finding.type === "fuel-per-lap" || finding.type === "tyre-wear");
    expect(restricted).toHaveLength(3);
    expect(
      restricted.every((finding) => finding.status === "indeterminate" && finding.confidence === "unknown" && finding.limitations.some((limitation) => limitation.code.startsWith("quality-policy-"))),
    ).toBe(true);
  });

  test("lap export renders deterministic findings section", () => {
    const packets = [reportSample(0, 0), reportSample(100, 1000)];
    const findings = adaptMetricsToFindings({
      gameId: "acc",
      sessionId: 7,
      lapId: 41,
      fuelPerLap: 2.4,
      tyreWear: 13,
      quality: { valid: true, reason: null },
    });
    const lap = {
      lapNumber: 2,
      lapTime: 90,
      isValid: true,
      carOrdinal: 1,
      trackOrdinal: 2,
      quality: reportQuality.quality,
      eligibility: reportQuality.eligibility,
      qualityGeneration: reportQuality.quality.provenance.outputGeneration,
    };

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
        gameId: "acc",
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
