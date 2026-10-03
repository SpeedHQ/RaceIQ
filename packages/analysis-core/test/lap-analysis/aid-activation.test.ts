import { describe, expect, test } from "bun:test";
import { registerGame } from "@raceiq/shared/games/registry";
import { forzaAdapter } from "@raceiq/game-fm-2023-metadata/index";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { runInsightScanWithCoverage } from "@raceiq/analysis-core/racing/analysis/laps/insights/scan";
import { detectAbsActivation, detectTractionControlActivation } from "@raceiq/analysis-core/racing/analysis/laps/insights/electronics";
import { calibratedWheelStates } from "@raceiq/analysis-core/racing/analysis/laps/physics/vehicle";
import type { F1ExtendedData } from "@raceiq/shared/telemetry/f1-2025";
import type { KunosExtendedData } from "@raceiq/shared/telemetry/kunos";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

registerGame(forzaAdapter);
const inferred = { nativeChannelAvailable: false, nativeChannelExplicit: false, wheelRotationAvailable: true };
const native = { nativeChannelAvailable: true, nativeChannelExplicit: true, wheelRotationAvailable: false };

function frame(index: number, overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    TimestampMS: index * 16,
    IsRaceOn: 1,
    Speed: 30,
    Accel: 0,
    Brake: 0,
    Clutch: 0,
    HandBrake: 0,
    Gear: 3,
    Steer: 0,
    AccelerationX: 0,
    AngularVelocityY: 0,
    CurrentEngineRpm: 5_000,
    EngineMaxRpm: 8_000,
    WheelRotationSpeedFL: 100,
    WheelRotationSpeedFR: 100,
    WheelRotationSpeedRL: 100,
    WheelRotationSpeedRR: 100,
    ...overrides,
  } as TelemetryPacket;
}

function brakingRun(): TelemetryPacket[] {
  return [100, 94, 100, 93, 99, 96].map((rotation, index) => frame(index, { Brake: 200, WheelRotationSpeedFL: rotation }));
}

function tractionRun(): TelemetryPacket[] {
  const coast = Array.from({ length: 50 }, (_, index) => frame(index));
  const acceleration = [5_000, 4_700, 5_000, 4_650, 5_000, 5_050].map((rpm, index) => frame(index + coast.length, {
    Accel: 220, CurrentEngineRpm: rpm, WheelRotationSpeedRL: 130, WheelRotationSpeedRR: 130,
  }));
  return [...coast, ...acceleration];
}

describe("static driver-aid activation detection", () => {
  test("infers repeated ABS modulation only from an available wheel source", () => {
    const telemetry = brakingRun();
    const insight = detectAbsActivation(telemetry, inferred);
    expect(insight?.id).toBe("driving-abs-activation");
    expect(insight?.evidenceSource).toBe("inferred");
    expect(insight?.frameIndices).toHaveLength(1);
    expect(detectAbsActivation(telemetry, { ...inferred, wheelRotationAvailable: false })).toBeNull();
  });

  test("requires calibrated wheelspin independent of RPM cuts", () => {
    const telemetry = tractionRun();
    const insight = detectTractionControlActivation(telemetry, { ...inferred, wheelStates: calibratedWheelStates(telemetry) });
    expect(insight?.id).toBe("driving-traction-control-activation");
    expect(insight?.evidenceSource).toBe("inferred");
    expect(detectTractionControlActivation(telemetry, inferred)).toBeNull();
    const gripping = telemetry.map((packet) => ({ ...packet, WheelRotationSpeedRL: 100, WheelRotationSpeedRR: 100 }));
    expect(detectTractionControlActivation(gripping, { ...inferred, wheelStates: calibratedWheelStates(gripping) })).toBeNull();
  });

  test("suppresses known-disabled aid inference", () => {
    const braking = brakingRun().map((packet) => ({ ...packet, acc: { abs: 0 } as KunosExtendedData }));
    const traction = tractionRun().map((packet) => ({ ...packet, acc: { tc: 0 } as KunosExtendedData }));
    expect(detectAbsActivation(braking, inferred)).toBeNull();
    expect(detectTractionControlActivation(traction, { ...inferred, wheelStates: calibratedWheelStates(traction) })).toBeNull();
    const f1Braking = brakingRun().map((packet) => ({ ...packet, f1: { antiLockBrakes: 0, motionEx: {} } as F1ExtendedData }));
    expect(detectAbsActivation(f1Braking, inferred)).toBeNull();
    const f1Traction = tractionRun().map((packet) => ({ ...packet, f1: { tractionControl: 0, motionEx: {} } as F1ExtendedData }));
    expect(detectTractionControlActivation(f1Traction, { ...inferred, wheelStates: calibratedWheelStates(f1Traction) })).toBeNull();
  });

  test("rejects F1 vehicle-speed wheel fallback without MotionEx", () => {
    const telemetry = brakingRun().map((packet) => ({ ...packet, f1: { antiLockBrakes: 1 } as F1ExtendedData }));
    expect(detectAbsActivation(telemetry, inferred)).toBeNull();
  });

  test("keeps native aid pulses separate across brief inactive intervals", () => {
    const telemetry = Array.from({ length: 64 }, (_, index) => frame(index, {
      acc: { abs: 0, tc: 0, absIntervention: index % 10 < 2 ? 1 : 0, tcIntervention: index % 10 < 2 ? 1 : 0 } as KunosExtendedData,
    }));
    for (const insight of [detectAbsActivation(telemetry, native), detectTractionControlActivation(telemetry, native)]) {
      expect(insight?.evidenceSource).toBe("native");
      expect(insight?.frameIndices).toHaveLength(7);
    }
  });

  test("duplicate-timestamp packets do not split an active burst", () => {
    const telemetry = Array.from({ length: 128 }, (_, index) => frame(index, {
      TimestampMS: Math.floor(index / 2) * 16,
      acc: { absIntervention: index % 20 < 4 ? 1 : 0, tcIntervention: index % 20 < 4 ? 1 : 0 } as KunosExtendedData,
    }));
    for (const insight of [detectAbsActivation(telemetry, native), detectTractionControlActivation(telemetry, native)]) {
      expect(insight?.frameIndices).toHaveLength(7);
    }
  });

  test("retains each separate native aid burst", () => {
    const telemetry = Array.from({ length: 120 }, (_, index) => {
      const active = index < 3 || (index >= 12 && index < 15) || (index >= 65 && index < 68) || (index >= 76 && index < 79) ? 1 : 0;
      return frame(index, { acc: { absIntervention: active, tcIntervention: active } as KunosExtendedData });
    });
    for (const insight of [detectAbsActivation(telemetry, native), detectTractionControlActivation(telemetry, native)]) {
      expect(insight?.frameIndices).toHaveLength(4);
    }
  });

  test("physics aid signal stays possible evidence, unlike explicit active flags", () => {
    const telemetry = Array.from({ length: 64 }, (_, index) => frame(index, {
      acc: { absIntervention: index % 10 < 2 ? 1 : 0, tcIntervention: index % 10 < 2 ? 1 : 0 } as KunosExtendedData,
    }));
    for (const insight of [
      detectAbsActivation(telemetry, { ...native, nativeChannelExplicit: false }),
      detectTractionControlActivation(telemetry, { ...native, nativeChannelExplicit: false }),
    ]) {
      expect(insight?.evidenceSource).toBe("inferred");
      expect(insight?.label).toMatch(/^Possible /);
      expect(insight?.detail).toContain("inferred from physics aid signal");
      expect(insight?.detail).not.toContain("reported by game");
    }
    const confirmed = detectTractionControlActivation(telemetry, native);
    expect(confirmed?.evidenceSource).toBe("native");
    expect(confirmed?.detail).toContain("explicit aid-active flag");
  });

  test("native duty cycle excludes samples whose intervention channel is unavailable", () => {
    const telemetry = Array.from({ length: 4 }, (_, index) => frame(index, {
      TimestampMS: index * 50,
      Brake: 200,
      acc: index < 2 ? { absIntervention: index === 0 ? 1 : 0 } as KunosExtendedData : undefined,
    }));
    const insight = detectAbsActivation(telemetry, native);
    expect(insight?.detail).toContain("50%");
    expect(insight?.detail).toContain("0.1s");
  });

  test("does not replace inactive native channels with inferred activity", () => {
    const braking = brakingRun().map((packet) => ({ ...packet, acc: { absIntervention: 0 } as KunosExtendedData }));
    const traction = tractionRun().map((packet) => ({ ...packet, acc: { tcIntervention: 0 } as KunosExtendedData }));
    expect(detectAbsActivation(braking, native)).toBeNull();
    expect(detectTractionControlActivation(traction, { ...native, wheelStates: calibratedWheelStates(traction) })).toBeNull();
  });

  test.each([
    ["shift", { Gear: 4 }],
    ["clutch", { Clutch: 200 }],
    ["pit", { acc: { pitStatus: "pit_lane" } as KunosExtendedData }],
    ["limiter", { CurrentEngineRpm: 7_900 }],
    ["kerb", { WheelOnRumbleStripRL: 1 }],
    ["pit limiter", { f1: { pitLimiterStatus: 1, motionEx: {} } as F1ExtendedData }],
  ] as const)("rejects RPM cuts around %s transitions", (_name, overrides) => {
    const telemetry = tractionRun();
    telemetry[50] = { ...telemetry[50], ...overrides };
    expect(detectTractionControlActivation(telemetry, { ...inferred, wheelStates: calibratedWheelStates(telemetry) })).toBeNull();
  });

  test("timestamp gaps cannot join separate ABS pulses", () => {
    const telemetry = brakingRun();
    for (let index = 3; index < telemetry.length; index++) telemetry[index].TimestampMS += 1_000;
    expect(detectAbsActivation(telemetry, inferred)).toBeNull();
  });

  test.each([20, 50, 100])("time-based ABS windows preserve modulation at %i Hz", (hz) => {
    const telemetry = Array.from({ length: hz + 1 }, (_, index) => frame(index, {
      TimestampMS: index * 1_000 / hz,
      Brake: 200,
      WheelRotationSpeedFL: 100 - 8 * (1 - Math.cos(2 * Math.PI * 5 * index / hz)) / 2,
    }));
    expect(detectAbsActivation(telemetry, inferred)?.frameIndices).toHaveLength(1);
  });

  test("static analysis dispatches source-gated inferred aids", () => {
    const traction = tractionRun();
    const braking = brakingRun().map((packet, index) => ({ ...packet, TimestampMS: (traction.length + index) * 16 }));
    const insights = analyzeLap([...traction, ...braking], "fm-2023");
    expect(insights.find((insight) => insight.id === "driving-abs-activation")?.evidenceSource).toBe("inferred");
    expect(insights.find((insight) => insight.id === "driving-traction-control-activation")?.evidenceSource).toBe("inferred");
  });

  test("coverage reports inferred TC without native aid channel", () => {
    const check = runInsightScanWithCoverage(tractionRun(), "fm-2023").detectorCoverage
      .find((item) => item.id === "driving-traction-control-activation");
    expect(check?.status).toBe("finding");
  });
});
