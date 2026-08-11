import { describe, expect, test } from "bun:test";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { initGameAdapters } from "@shared/games/init";
import { MIN_REPORTABLE_LOSS_S } from "@shared/racing/analysis/laps/time-loss";
import type { ChannelQualitySummary, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";

const RADIUS = 0.33;
const STEP_MS = 16;
const STEP_S = STEP_MS / 1000;

const ANALYSIS_CHANNELS = [
  "timing.distance-traveled",
  "motion.speed",
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "tires.tire-slip-ratio",
  "tires.tire-slip-angle",
  "tires.wheel-rotation-speed",
  "suspension.norm-suspension-travel",
  "fuel.fuel",
  "tire.temperature.average",
  "tires.tire-wear",
] as const;
const ANALYSIS_QUALITY = {
  lifecycleState: "exact",
  complete: true,
  structurallyValid: true,
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
  channelQuality: ANALYSIS_CHANNELS.map(
    (semanticId) =>
      ({
        semanticId,
        channelFamily: semanticId.split(".")[0] as ChannelQualitySummary["channelFamily"],
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
      }) satisfies ChannelQualitySummary,
  ),
  facts: [],
  classification: {
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
  },
} as unknown as LapQualitySummary;

initGameAdapters();
interface Frame {
  speed: number;
  accel?: number;
  brake?: number;
  locked?: boolean;
}

/**
 * Builds a lap from a list of phases, each contributing `n` frames. Speed is
 * integrated from the phase's acceleration so the packets stay self-consistent
 * (time-loss estimation reads Speed, TimestampMS and dt together).
 */
function lap(phases: { n: number; a: number; accel: number; brake?: number; locked?: boolean }[], v0 = 40): TelemetryPacket[] {
  const out: TelemetryPacket[] = [];
  let v = v0;
  let t = 0;
  for (const phase of phases) {
    for (let i = 0; i < phase.n; i++) {
      out.push(pkt({ speed: v, accel: phase.accel, brake: phase.brake, locked: phase.locked }, t));
      v = Math.max(1, v + phase.a * STEP_S);
      t += STEP_MS;
    }
  }
  return out;
}

function pkt(f: Frame, t: number): TelemetryPacket {
  const rot = f.speed / RADIUS;
  return {
    TimestampMS: t,
    Speed: f.speed,
    Accel: f.accel ?? 0,
    Brake: f.brake ?? 0,
    Steer: 0,
    WheelRotationSpeedFL: f.locked ? 0 : rot,
    WheelRotationSpeedFR: rot,
    WheelRotationSpeedRL: rot,
    WheelRotationSpeedRR: rot,
  } as unknown as TelemetryPacket;
}

function find(insights: ReturnType<typeof analyzeLap>, id: string) {
  return insights.find((i) => i.id === id);
}

function analyzeFixtureLap(telemetry: TelemetryPacket[], gameId: Parameters<typeof analyzeLap>[1]) {
  return analyzeLap(telemetry, gameId, ANALYSIS_QUALITY);
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
  function lockedLap(): TelemetryPacket[] {
    return lap([{ n: 20, a: -2, accel: 0, brake: 200, locked: true }], 30);
  }

  test("retains lockup insights when wheel rotation is available", () => {
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
  function fuelLap(startFuel: number, endFuel: number): TelemetryPacket[] {
    const telemetry = lap([{ n: 10, a: 0, accel: 128 }]);
    telemetry[0].Fuel = startFuel;
    telemetry[telemetry.length - 1].Fuel = endFuel;
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
