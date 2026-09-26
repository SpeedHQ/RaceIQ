import { describe, expect, test } from "bun:test";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { runInsightScanWithCoverage } from "@shared/racing/analysis/laps/insights/scan";
import { initGameAdapters } from "@shared/games/init";
import { MIN_REPORTABLE_LOSS_S } from "@shared/racing/analysis/laps/time-loss";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { LapInsight } from "../../shared/racing/analysis/laps/insights/types";

const RADIUS = 0.33;
const STEP_MS = 16;
const STEP_S = STEP_MS / 1000;

initGameAdapters();
interface Frame {
  speed: number;
  accel?: number;
  brake?: number;
  locked?: boolean;
  steer?: number;
  accelerationX?: number;
  yawRate?: number;
  frontSlip?: number;
  rearSlip?: number;
  pressures?: readonly [number, number, number, number];
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
    Steer: f.steer ?? 0,
    HandBrake: 0,
    AccelerationX: f.accelerationX ?? 0,
    AngularVelocityY: f.yawRate ?? 0,
    TireSlipAngleFL: f.frontSlip ?? 0,
    TireSlipAngleFR: f.frontSlip ?? 0,
    TireSlipAngleRL: f.rearSlip ?? 0,
    TireSlipAngleRR: f.rearSlip ?? 0,
    TirePressureFrontLeft: f.pressures?.[0],
    TirePressureFrontRight: f.pressures?.[1],
    TirePressureRearLeft: f.pressures?.[2],
    TirePressureRearRight: f.pressures?.[3],
    WheelRotationSpeedFL: f.locked ? 0 : rot,
    WheelRotationSpeedFR: rot,
    WheelRotationSpeedRL: rot,
    WheelRotationSpeedRR: rot,
  } as unknown as TelemetryPacket;
}

function find(insights: LapInsight[], id: string) {
  return insights.find((insight) => insight.id === id);
}

function repeated(count: number, frame: Frame): TelemetryPacket[] {
  return Array.from({ length: count }, (_, index) => pkt(frame, index * STEP_MS));
}

describe("analyzeLap time-loss quantification", () => {
  test("coasting that is not corner entry is charged for the speed it bled", () => {
    const insights = analyzeLap(
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
    const insights = analyzeLap(
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


  test("a lap too short to analyse yields nothing rather than guesses", () => {
    expect(analyzeLap(lap([{ n: 5, a: 0, accel: 255 }]), "fm-2023")).toEqual([]);
  });
});

describe("analyzeLap wheel-state capabilities", () => {
  function lockedLap(): TelemetryPacket[] {
    return lap([{ n: 60, a: 0, accel: 0 }, { n: 20, a: -2, accel: 0, brake: 200, locked: true }], 30);
  }

  test("retains lockup insights when wheel rotation is available", () => {
    const insights = analyzeLap(lockedLap(), "fm-2023");

    expect(find(insights, "tire-lockup-FL")).toBeDefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeDefined();
  });

  test("omits lockup insights when iRacing wheel rotation is unavailable", () => {
    const insights = analyzeLap(lockedLap(), "iracing");

    expect(find(insights, "tire-lockup-FL")).toBeUndefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeUndefined();
  });

  test("coverage distinguishes observed lockups from unsupported wheel checks", () => {
    const packets = lockedLap();
    const forza = runInsightScanWithCoverage(packets, "fm-2023");
    const iracing = runInsightScanWithCoverage(packets, "iracing");
    expect(forza.detectorCoverage).toHaveLength(37);
    expect(forza.detectorCoverage.find((check) => check.id === "tire-lockup")?.status).toBe("finding");
    expect(iracing.detectorCoverage.find((check) => check.id === "tire-lockup")).toMatchObject({
      status: "unavailable",
      reason: "Continuous direct wheel-rotation telemetry unavailable",
    });
    expect(iracing.detectorCoverage.find((check) => check.id === "driving-abs-activation")?.status).toBe("unavailable");
    expect(forza.detectorCoverage.find((check) => check.id === "tire-spin")?.status).toBe("checked");
  });
});

describe("analyzeLap deterministic signal guards", () => {
  test("does not interpret Forza normalized lateral slip as radians", () => {
    const telemetry = repeated(30, {
      speed: 40,
      steer: 50,
      accelerationX: -9.81,
      yawRate: 9.81 / 40,
      frontSlip: 0.9,
      rearSlip: 0.1,
    });

    expect(find(analyzeLap(telemetry, "fm-2023"), "driving-understeer-scrub")).toBeUndefined();
  });

  test("detects sustained physical oversteer", () => {
    const telemetry = repeated(30, {
      speed: 40,
      steer: 35,
      accelerationX: -9.81,
      yawRate: 0.8,
      frontSlip: 0.02,
      rearSlip: 0.2,
    });

    expect(find(analyzeLap(telemetry, "f1-2025"), "driving-oversteer-slide")).toBeDefined();
  });

  test("detects persistent left-right pressure imbalance", () => {
    const telemetry = repeated(120, {
      speed: 40,
      pressures: [28, 25.5, 27, 27],
    });

    const insight = find(analyzeLap(telemetry, "f1-2025"), "tire-pressure-imbalance");
    expect(insight).toBeDefined();
    expect(insight?.detail).toContain("front left tire averaged 2.5 psi higher");
  });
});

describe("analyzeLap fuel units", () => {
  function fuelLap(startFuel: number, endFuel: number): TelemetryPacket[] {
    const telemetry = lap([{ n: 20, a: 0, accel: 128 }]);
    telemetry[0].Fuel = startFuel;
    telemetry[telemetry.length - 1].Fuel = endFuel;
    return telemetry;
  }

  test("reports litre-based iRacing consumption in litres", () => {
    const fuel = find(analyzeLap(fuelLap(40, 38.5), "iracing"), "mech-fuel");

    expect(fuel?.detail).toBe("Used 1.50 L — ~25.7 laps remaining");
  });

  test("retains percentage consumption for fractional-fuel games", () => {
    const fuel = find(analyzeLap(fuelLap(0.8, 0.75), "fm-2023"), "mech-fuel");

    expect(fuel?.detail).toBe("Used 5.0% — ~15.0 laps remaining");
  });
});
