import { describe, expect, test } from "bun:test";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import type { LapInsight } from "@shared/racing/analysis/laps/insights/types";
import { evaluateEligibility } from "@shared/racing/quality/policies";
import { initGameAdapters } from "@shared/games/init";
import { MIN_REPORTABLE_LOSS_S } from "@shared/racing/analysis/laps/time-loss";
import { QUALITY_THRESHOLDS_V1 } from "@shared/racing/quality/measure";
import type { ChannelQualitySummary, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { TelemetryGroupId, TelemetryVariableId } from "../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import type { SemanticTelemetrySample } from "../../shared/telemetry/replay/contracts";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";

const RADIUS = 0.33;
const STEP_MS = 16;
const STEP_S = STEP_MS / 1000;

const ANALYSIS_CHANNELS = [
  { semanticId: "timing.distance-traveled", channelFamily: "timing" },
  { semanticId: "motion.speed", channelFamily: "motion" },
  { semanticId: "inputs.accel", channelFamily: "inputs" },
  { semanticId: "inputs.brake", channelFamily: "inputs" },
  { semanticId: "inputs.steer", channelFamily: "inputs" },
  { semanticId: "tires.tire-slip-ratio", channelFamily: "tires" },
  { semanticId: "tires.tire-slip-angle", channelFamily: "tires" },
  { semanticId: "tires.wheel-rotation-speed", channelFamily: "tires" },
  { semanticId: "suspension.norm-suspension-travel", channelFamily: "suspension" },
  { semanticId: "fuel.fuel", channelFamily: "fuel" },
  { semanticId: "tire.temperature.average", channelFamily: "tires" },
  { semanticId: "tires.tire-wear", channelFamily: "tires" },
] as const satisfies readonly { semanticId: TelemetryVariableId; channelFamily: TelemetryGroupId }[];

const ANALYSIS_PROVENANCE = {
  schemaVersion: "1",
  policyVersion: "1",
  configurationVersion: "1",
  sourceGeneration: `sha256:${"a".repeat(64)}`,
  outputGeneration: `sha256:${"b".repeat(64)}`,
};

const ANALYSIS_QUALITY: LapQualitySummary = {
  lifecycleState: "exact",
  complete: true,
  structurallyValid: true,
  invalidReason: null,
  timing: {
    source: "simulator-last-lap",
    lapTimeMs: 10_000,
    peakTelemetryLapTimeMs: 10_000,
    confirmed: true,
  },
  gapSummary: {
    expectedCount: 100,
    observedCount: 100,
    totalMissingCount: 0,
    totalMissingFraction: 0,
    largestContiguousGapMs: 0,
    countMethod: "native-sequence",
  },
  trackDistanceCoverage: 1,
  worldPositionCoverage: 1,
  channelQuality: ANALYSIS_CHANNELS.map(({ semanticId, channelFamily }) => ({
    semanticId,
    channelFamily,
    mappingStatus: "direct",
    canonicalUnit: null,
    nativeUnit: null,
    coverage: 1,
    observedCount: 100,
    expectedCount: 100,
    expectedCadenceMs: STEP_MS,
    observedCadenceMs: STEP_MS,
    boundaryCoverage: { first500Ms: 1, last500Ms: 1 },
    confidenceMean: 1,
    freshnessCounts: { fresh: 100, stale: 0, unknown: 0 },
    resolutionCounts: { ok: 100, missing: 0, stale: 0, invalid: 0, "not-applicable": 0, error: 0 },
    issueIntervals: [],
    limitations: [],
    provenance: null,
    sourceProfile: null,
  })),
  facts: [],
  sourceKind: "native-live",
  participant: { kind: "player", sourceId: null, stableId: "test-player", identityState: "stable" },
  classification: {
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
  },
  thresholds: { ...QUALITY_THRESHOLDS_V1 },
  versionIdentity: TEST_VERSION_IDENTITY,
  provenance: ANALYSIS_PROVENANCE,
};
initGameAdapters();
const CLEAN_QUALITY = summarize(qualityPackets(200).map((packet) => ({ ...packet, gameId: "fm-2023" })));

interface Frame {
  speed: number;
  accel?: number;
  brake?: number;
  locked?: boolean;
}

/**
 * Builds a lap from phases. Canonical values use catalog units: speed in m/s,
 * inputs in simulator's 0–255 scale, and wheel rotation in rad/s.
 */
function lap(phases: { n: number; a: number; accel: number; brake?: number; locked?: boolean }[], v0 = 40): SemanticTelemetrySample[] {
  const out: SemanticTelemetrySample[] = [];
  let speed = v0;
  let observedAtMs = 0;
  for (const phase of phases) {
    for (let index = 0; index < phase.n; index++) {
      const rotation = speed / RADIUS;
      out.push({
        sequence: String(observedAtMs),
        observedAtMs,
        values: {
          "timing.distance-traveled": (observedAtMs / 1_000) * speed,
          "motion.speed": speed,
          "inputs.accel": phase.accel,
          "inputs.brake": phase.brake ?? 0,
          "inputs.steer": 0,
          "engine.engine-max-rpm": 8_000,
          "engine.current-engine-rpm": 4_000,
          "tires.wheel-rotation-speed": [phase.locked ? 0 : rotation, rotation, rotation, rotation],
        },
      });
      speed = Math.max(1, speed + phase.a * STEP_S);
      observedAtMs += STEP_MS;
    }
  }
  return out;
}

function find(insights: readonly LapInsight[], id: string) {
  return insights.find((insight) => insight.id === id);
}

function analyzeFixtureLap(samples: SemanticTelemetrySample[], gameId: Parameters<typeof analyzeLap>[1]) {
  return analyzeLap(samples, gameId, ANALYSIS_QUALITY);
}

const LOCALIZED_ISSUE_RANGE = { startFraction: 0.2, endFraction: 0.4 };

function qualityWithLocalizedIssue(semanticId: ChannelQualitySummary["semanticId"]): LapQualitySummary {
  const quality = structuredClone(ANALYSIS_QUALITY);
  const channel = quality.channelQuality.find((candidate) => candidate.semanticId === semanticId);
  if (!channel) throw new Error(`Missing analysis channel ${semanticId}`);
  channel.issueIntervals.push({
    state: "missing",
    freshness: "unknown",
    timeRange: { startMs: 320, endMs: 640 },
    distanceRange: LOCALIZED_ISSUE_RANGE,
    count: 20,
  });
  return quality;
}

function qualityWithLocalizedWarning(): LapQualitySummary {
  const quality = structuredClone(ANALYSIS_QUALITY);
  quality.facts.push({
    id: "test:localized-minor-gap",
    code: "telemetry_gap_minor",
    severity: "warning",
    timeRange: { startMs: 320, endMs: 352 },
    distanceRange: LOCALIZED_ISSUE_RANGE,
    semanticIds: [],
    channelFamilies: [],
    provenance: quality.provenance,
    eventIds: [],
  });
  return quality;
}

function qualityWithGlobalWarning(): LapQualitySummary {
  const quality = structuredClone(ANALYSIS_QUALITY);
  quality.timing.source = "telemetry-elapsed";
  return quality;
}

function localizedInsightLap(): SemanticTelemetrySample[] {
  return lap([{ n: 100, a: 0, accel: 128 }], 30).map((sample, index) => ({
    ...sample,
    values: {
      ...sample.values,
      "timing.distance-traveled": index,
    },
  }));
}

function markFrames(telemetry: SemanticTelemetrySample[], start: number, end: number, update: (values: SemanticTelemetrySample["values"]) => SemanticTelemetrySample["values"]): void {
  for (let index = start; index <= end; index++) {
    const sample = telemetry[index]!;
    telemetry[index] = { ...sample, values: update(sample.values) };
  }
}
function lockFrontLeft(values: SemanticTelemetrySample["values"]): SemanticTelemetrySample["values"] {
  const rotation = values["tires.wheel-rotation-speed"];
  if (!Array.isArray(rotation) || rotation.length !== 4 || !rotation.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Expected complete wheel rotation fixture");
  }
  return {
    ...values,
    "tires.wheel-rotation-speed": [0, rotation[1], rotation[2], rotation[3]],
  };
}

describe("analyzeLap time-loss quantification", () => {
  test("coasting that is not corner entry is charged for the speed it bled", () => {
    const insights = analyzeFixtureLap(
      lap([
        // Establish what the car can do: a long clean full-throttle pull.
        { n: 400, a: 4, accel: 255 },
        // Dead time: 1.6 s off both pedals, decelerating on drag.
        { n: 100, a: -2, accel: 0 },
        // Back to power, and never brakes — so this coast is not corner entry.
        { n: 300, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    const coasting = find(insights, "driving-coasting");
    expect(coasting).toBeDefined();
    expect(coasting!.timeLossS).toBeDefined();
    expect(coasting!.timeLossS!).toBeGreaterThanOrEqual(MIN_REPORTABLE_LOSS_S);
    // Cannot cost more than the 1.6 s the coast itself occupied.
    expect(coasting!.timeLossS!).toBeLessThanOrEqual(1.6);
  });

  test("a coast that runs into braking is deliberate corner entry, not charged", () => {
    const insights = analyzeFixtureLap(
      lap([
        { n: 400, a: 4, accel: 255 },
        { n: 100, a: -2, accel: 0 },
        // Hard braking immediately after the release.
        { n: 60, a: -12, accel: 0, brake: 200 },
        { n: 200, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    const coasting = find(insights, "driving-coasting");
    expect(coasting).toBeDefined();
    expect(coasting!.timeLossS).toBeUndefined();
  });

  test("detectors that only describe a symptom stay unquantified", () => {
    const insights = analyzeFixtureLap(
      lap([
        { n: 400, a: 4, accel: 255 },
        { n: 100, a: -2, accel: 0 },
        { n: 300, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    // Whatever else fires on this synthetic lap, no insight may claim a
    // negative or absurd cost, and unquantified must mean absent (not 0).
    for (const i of insights) {
      if (i.timeLossS === undefined) continue;
      expect(i.timeLossS).toBeGreaterThanOrEqual(MIN_REPORTABLE_LOSS_S);
      expect(i.timeLossS).toBeLessThan(13);
    }
  });

  test("a lap too short to analyse yields nothing rather than guesses", () => {
    expect(analyzeFixtureLap(lap([{ n: 5, a: 0, accel: 255 }]), "fm-2023")).toEqual([]);
  });
});

describe("analyzeLap wheel-state capabilities", () => {
  function lockedLap(): SemanticTelemetrySample[] {
    return lap([{ n: 20, a: -2, accel: 0, brake: 200, locked: true }], 30);
  }

  test("retains lockup insights when wheel rotation is available", () => {
    expect(evaluateEligibility("transient-event", CLEAN_QUALITY).status).toBe("ineligible");
    const insights = analyzeFixtureLap(lockedLap(), "fm-2023");

    expect(find(insights, "tire-lockup-FL")).toBeDefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeDefined();
  });

  test("omits lockup insights when iRacing wheel rotation is unavailable", () => {
    const insights = analyzeFixtureLap(lockedLap(), "iracing");

    expect(find(insights, "tire-lockup-FL")).toBeUndefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeUndefined();
  });
});

describe("analyzeLap fuel units", () => {
  function fuelLap(startFuel: number, endFuel: number): SemanticTelemetrySample[] {
    const telemetry = lap([{ n: 10, a: 0, accel: 128 }]);
    const first = telemetry[0]!;
    const lastIndex = telemetry.length - 1;
    const last = telemetry[lastIndex]!;
    telemetry[0] = { ...first, values: { ...first.values, "fuel.fuel": startFuel } };
    telemetry[lastIndex] = { ...last, values: { ...last.values, "fuel.fuel": endFuel } };
    return telemetry;
  }

  test("reports litre-based iRacing consumption in litres", () => {
    const fuel = find(analyzeFixtureLap(fuelLap(40, 38.5), "iracing"), "mech-fuel");

    expect(fuel?.detail).toBe("Used 1.50 L — ~25.7 laps remaining");
  });

  test("retains percentage consumption for fractional-fuel games", () => {
    const fuel = find(analyzeFixtureLap(fuelLap(0.8, 0.75), "fm-2023"), "mech-fuel");

    expect(fuel?.detail).toBe("Used 5.0% — ~15.0 laps remaining");
  });
});

describe("analyzeLap localized insight eligibility", () => {
  test("keeps global warning limitations while ranged warnings exclude affected events", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 22, 33, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));
    markFrames(telemetry, 22, 27, lockFrontLeft);
    markFrames(telemetry, 60, 71, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));
    markFrames(telemetry, 60, 65, lockFrontLeft);
    const globalQuality = qualityWithGlobalWarning();

    const decision = evaluateEligibility("corner-trace", globalQuality);
    const globalInsights = analyzeLap(telemetry, "fm-2023", globalQuality);
    const rangedInsights = analyzeLap(telemetry, "fm-2023", qualityWithLocalizedWarning());

    expect(decision.status).toBe("eligible_with_warning");
    expect(decision.reasons).toContainEqual(
      expect.objectContaining({
        code: "lap_time_fallback",
        timeRange: null,
        distanceRange: null,
      }),
    );
    expect(find(globalInsights, "driving-rev-limiter")?.frameIndices).toEqual([28, 66]);
    expect(find(globalInsights, "tire-lockup-FL")?.frameIndices).toEqual([25, 63]);
    expect(find(rangedInsights, "driving-rev-limiter")?.frameIndices).toEqual([66]);
    expect(find(rangedInsights, "tire-lockup-FL")?.frameIndices).toEqual([63]);
  });

  test("analyzes corner events outside a policy-ineligible range and remaps source frames", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 60, 71, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));

    const insight = find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedIssue("inputs.steer")), "driving-rev-limiter");

    expect(insight?.frameIndices).toEqual([66]);
  });

  test("excludes corner warning ranges while retaining and remapping unaffected events", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 22, 33, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));
    markFrames(telemetry, 60, 71, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));

    const insight = find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedWarning()), "driving-rev-limiter");

    expect(insight?.frameIndices).toEqual([66]);
  });

  test("does not emit corner insights confined to a policy-ineligible range", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 22, 33, (values) => ({ ...values, "engine.current-engine-rpm": 8_000 }));

    expect(find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedIssue("inputs.steer")), "driving-rev-limiter")).toBeUndefined();
  });

  test("analyzes transient events outside a policy-ineligible range and remaps source frames", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 60, 65, lockFrontLeft);

    const insight = find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedIssue("tires.wheel-rotation-speed")), "tire-lockup-FL");

    expect(insight?.frameIndices).toEqual([63]);
  });

  test("excludes transient warning ranges while retaining and remapping unaffected events", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 22, 27, lockFrontLeft);
    markFrames(telemetry, 60, 65, lockFrontLeft);

    const insight = find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedWarning()), "tire-lockup-FL");

    expect(insight?.frameIndices).toEqual([63]);
  });

  test("does not emit transient insights confined to a policy-ineligible range", () => {
    const telemetry = localizedInsightLap();
    markFrames(telemetry, 22, 27, lockFrontLeft);

    expect(find(analyzeLap(telemetry, "fm-2023", qualityWithLocalizedIssue("tires.wheel-rotation-speed")), "tire-lockup-FL")).toBeUndefined();
  });
});
