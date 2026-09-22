import { describe, expect, test } from "bun:test";
import { calibratedWheelStates, type AllWheelStates } from "../../shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function packet(timestamp: number, overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    TimestampMS: timestamp,
    Speed: 30,
    Accel: 0,
    Brake: 0,
    HandBrake: 0,
    Steer: 0,
    AccelerationX: 0,
    AngularVelocityY: 0,
    WheelRotationSpeedFL: 90,
    WheelRotationSpeedFR: 90,
    WheelRotationSpeedRL: 90,
    WheelRotationSpeedRR: 90,
    ...overrides,
  } as TelemetryPacket;
}

function coast(start = 0, step = 20, overrides: Partial<TelemetryPacket> = {}): TelemetryPacket[] {
  return Array.from({ length: Math.round(600 / step) + 1 }, (_, i) => packet(start + i * step, overrides));
}

function states(frame: AllWheelStates): string[] {
  return [frame.fl.state, frame.fr.state, frame.rl.state, frame.rr.state];
}

const grip = ["grip", "grip", "grip", "grip"];
const idle = ["idle", "idle", "idle", "idle"];

describe("lap wheel radius calibration", () => {
  test("coast calibration survives partial front lockup and release", () => {
    const telemetry = coast();
    telemetry.push(packet(620, { Brake: 200, WheelRotationSpeedFL: 60, WheelRotationSpeedFR: 60 }));
    telemetry.push(packet(640));
    const result = calibratedWheelStates(telemetry);
    expect(states(result[0])).toEqual(idle);
    expect(states(result[30])).toEqual(grip);
    expect(states(result[31])).toEqual(["lockup", "lockup", "grip", "grip"]);
    expect(result[31].fl.slipRatio).toBeCloseTo(-1 / 3);
    expect(result[31].rl.slipRatio).toBeCloseTo(0);
    expect(states(result[32])).toEqual(grip);
  });

  test("rear spin and sustained equal all-wheel spin cannot renormalize learned radius", () => {
    const telemetry = coast();
    telemetry.push(packet(620, { Accel: 255, WheelRotationSpeedRL: 150, WheelRotationSpeedRR: 150 }));
    for (let t = 640; t <= 1840; t += 20) {
      telemetry.push(packet(t, {
        // Even after the driver lifts, agreement cannot overwrite known radius.
        Accel: t < 1000 ? 255 : 0,
        WheelRotationSpeedFL: 150, WheelRotationSpeedFR: 150,
        WheelRotationSpeedRL: 150, WheelRotationSpeedRR: 150,
      }));
    }
    const result = calibratedWheelStates(telemetry);
    expect(states(result[31])).toEqual(["grip", "grip", "spin", "spin"]);
    expect(result.slice(32).every((frame) => states(frame).every((state) => state === "spin"))).toBe(true);
    expect(result[result.length - 1].fl.slipRatio).toBeCloseTo(0.4);
  });

  test("braking and all-wheel acceleration cannot establish their own radius", () => {
    const braking = coast(0, 20, { Brake: 200, WheelRotationSpeedFL: 60, WheelRotationSpeedFR: 60 });
    const spinning = coast(0, 20, {
      Accel: 255, WheelRotationSpeedFL: 150, WheelRotationSpeedFR: 150,
      WheelRotationSpeedRL: 150, WheelRotationSpeedRR: 150,
    });
    for (const telemetry of [braking, spinning]) {
      expect(calibratedWheelStates(telemetry).every((frame) => states(frame).every((state) => state === "idle"))).toBe(true);
    }
  });

  test("clock gaps and resets invalidate inferred radius until a fresh coast", () => {
    for (const restart of [2000, 0]) {
      const telemetry = coast();
      telemetry.push(packet(restart, { Brake: 200, WheelRotationSpeedFL: 60 }));
      telemetry.push(packet(restart + 20, { Brake: 200, WheelRotationSpeedFL: 60 }));
      telemetry.push(...coast(restart + 40));
      telemetry.push(packet(restart + 660, { Brake: 200, WheelRotationSpeedFL: 60 }));
      const result = calibratedWheelStates(telemetry);
      expect(states(result[31])).toEqual(idle);
      expect(states(result[32])).toEqual(idle);
      expect(states(result[result.length - 2])).toEqual(grip);
      expect(result[result.length - 1].fl.state).toBe("lockup");
    }
  });

  test("zero/nonfinite rotation dropouts cannot become lockups or retain stale calibration", () => {
    for (const rotation of [0, Number.NaN]) {
      const telemetry = coast();
      telemetry.push(packet(620, { WheelRotationSpeedFL: rotation }));
      telemetry.push(packet(640, { Brake: 200, WheelRotationSpeedFL: 60 }));
      const result = calibratedWheelStates(telemetry);
      expect(states(result[31])).toEqual(idle);
      expect(states(result[32])).toEqual(idle);
    }
  });

  test("stopped wheel under brakes remains a lockup when radius is known", () => {
    const telemetry = coast();
    telemetry.push(packet(620, { Brake: 200, WheelRotationSpeedFL: 0 }));
    const result = calibratedWheelStates(telemetry);
    expect(states(result[31])).toEqual(["lockup", "grip", "grip", "grip"]);
    expect(result[31].fl.slipRatio).toBe(-1);
  });

  test("stopping discards calibration rather than classifying restart using stale radius", () => {
    const telemetry = coast();
    telemetry.push(packet(620, { Speed: 0, WheelRotationSpeedFL: 0, WheelRotationSpeedFR: 0, WheelRotationSpeedRL: 0, WheelRotationSpeedRR: 0 }));
    telemetry.push(packet(640, { Accel: 255, WheelRotationSpeedRL: 150, WheelRotationSpeedRR: 150 }));
    const result = calibratedWheelStates(telemetry);
    expect(states(result[31])).toEqual(idle);
    expect(states(result[32])).toEqual(idle);
  });

  test("cornering or inconsistent rotations never establish a rolling baseline", () => {
    const cornering = coast(0, 20, { Steer: 30, AccelerationX: 5, AngularVelocityY: 0.2 });
    const unequal = coast(0, 20, { WheelRotationSpeedRL: 110, WheelRotationSpeedRR: 110 });
    for (const telemetry of [cornering, unequal]) {
      expect(calibratedWheelStates(telemetry).every((frame) => states(frame).every((state) => state === "idle"))).toBe(true);
    }
  });

  test("calibration requires elapsed time, not packet count", () => {
    for (const step of [10, 50]) {
      const telemetry = coast(0, step);
      const result = calibratedWheelStates(telemetry);
      expect(states(result[Math.round(400 / step)])).toEqual(idle);
      expect(states(result[result.length - 1])).toEqual(grip);
    }
    const duplicates = Array.from({ length: 100 }, () => packet(0));
    expect(calibratedWheelStates(duplicates).every((frame) => states(frame).every((state) => state === "idle"))).toBe(true);
  });

  test("F1 synthetic vehicle-speed wheels are not independent traction evidence", () => {
    const telemetry = coast(0, 20, { gameId: "f1-2025" });
    telemetry.push(packet(620, { gameId: "f1-2025", Brake: 200, WheelRotationSpeedFL: 0 }));
    expect(states(calibratedWheelStates(telemetry).at(-1)!)).toEqual(idle);
  });

  test("authoritative per-wheel radii classify immediately without axle averaging", () => {
    const overrides = {
      Accel: 255,
      WheelRotationSpeedFL: 100, WheelRotationSpeedFR: 100,
      WheelRotationSpeedRL: 75, WheelRotationSpeedRR: 75,
      acc: { tireRadius: [0.3, 0.3, 0.4, 0.4] } as NonNullable<TelemetryPacket["acc"]>,
    };
    const result = calibratedWheelStates([
      packet(0, overrides), packet(20, overrides),
      packet(40, { ...overrides, Accel: 0, Brake: 200, WheelRotationSpeedFL: 60 }),
    ]);
    expect(states(result[0])).toEqual(grip);
    expect(states(result[2])).toEqual(["lockup", "grip", "grip", "grip"]);
    expect(result[2].fl.slipRatio).toBeCloseTo(-0.4);
  });

  test("invalid authoritative radii abstain per wheel without masking valid radii", () => {
    const overrides = {
      Accel: 255,
      acc: { tireRadius: [1 / 3, 0, Number.NaN, Number.POSITIVE_INFINITY] } as NonNullable<TelemetryPacket["acc"]>,
    };
    const result = calibratedWheelStates([packet(0, overrides), packet(20, overrides)]);
    expect(states(result[1])).toEqual(["grip", "idle", "idle", "idle"]);
  });
});
