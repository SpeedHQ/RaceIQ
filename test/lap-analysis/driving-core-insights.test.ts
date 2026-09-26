import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { AllWheelStates } from "../../shared/racing/analysis/laps/physics/vehicle";
import {
  detectBinaryThrottle,
  detectCoasting,
  detectDelayedThrottlePickup,
  detectEarlyBraking,
  detectEarlyThrottle,
  detectOverSlowing,
} from "../../shared/racing/analysis/laps/insights/driving-core";

function recording(hz: number, seconds: number, at: (t: number) => Partial<TelemetryPacket>): TelemetryPacket[] {
  return Array.from({ length: Math.round(hz * seconds) }, (_, i) => ({
    gameId: "fm-2023",
    TimestampMS: i * 1000 / hz,
    IsRaceOn: 1,
    Speed: 25,
    Steer: 0,
    Accel: 0,
    Brake: 0,
    Clutch: 0,
    HandBrake: 0,
    Gear: 3,
    AccelerationX: 0,
    AngularVelocityY: 0,
    ...at(i / hz),
  } as TelemetryPacket));
}

function exit(hz: number): TelemetryPacket[] {
  return recording(hz, 4, (t) => ({
    Steer: t < 1 ? 50 : t < 1.5 ? 50 - 80 * (t - 1) : 10,
    Speed: t < 1 ? 26 - t : 25,
    AccelerationX: t < 1 ? 6 : t < 1.5 ? 6 - 10 * (t - 1) : 1,
    AngularVelocityY: t < 1 ? 0.24 : t < 1.5 ? 0.24 - 0.4 * (t - 1) : 0.04,
    Accel: t < 2.6 ? 0 : 180,
  }));
}

const grip: AllWheelStates = {
  fl: { state: "grip", slipRatio: 0 }, fr: { state: "grip", slipRatio: 0 },
  rl: { state: "grip", slipRatio: 0 }, rr: { state: "grip", slipRatio: 0 },
};

describe("corner control observations", () => {
  for (const hz of [20, 60, 120]) {
    test(`${hz} Hz: flat-out straights and progressive corner power stay quiet`, () => {
      const straight = recording(hz, 4, () => ({ Accel: 255 }));
      const corner = recording(hz, 4, (t) => ({
        Steer: 50, AccelerationX: 8, AngularVelocityY: 0.32,
        Accel: Math.min(255, t * 100),
      }));
      for (const packets of [straight, corner]) {
        expect(detectBinaryThrottle(packets)).toBeNull();
        expect(detectEarlyThrottle(packets)).toBeNull();
        expect(detectDelayedThrottlePickup(packets)).toBeNull();
      }
    });

    test(`${hz} Hz: abrupt corner power reversal is localized`, () => {
      const packets = recording(hz, 3, (t) => ({
        Steer: 50, AccelerationX: 8, AngularVelocityY: 0.32,
        Accel: t >= 0.5 && t < 0.9 ? 255 : 0,
      }));
      for (const insight of [detectBinaryThrottle(packets), detectEarlyThrottle(packets)]) {
        expect(insight?.frameIndices).toHaveLength(1);
        expect(packets[insight!.frameIndices[0]].TimestampMS).toBeGreaterThanOrEqual(500);
        expect(packets[insight!.frameIndices[0]].TimestampMS).toBeLessThan(900);
        expect(insight?.timeLossS).toBeUndefined();
      }
    });

    test(`${hz} Hz: nearby throttle reversals merge within detector-specific gaps`, () => {
      const packets = recording(hz, 3, (t) => ({
        Steer: 50, AccelerationX: 8, AngularVelocityY: 0.32,
        Accel: (t >= 0.5 && t < 0.7) || (t >= 0.95 && t < 1.15) ? 255 : 0,
      }));
      expect(detectEarlyThrottle(packets)?.frameIndices).toHaveLength(2);
      expect(detectBinaryThrottle(packets)?.frameIndices).toHaveLength(1);
    });

    test(`${hz} Hz: short reversals merge for both detectors; distant ones remain separate`, () => {
      for (const [secondStart, expected] of [[0.8, 1], [1.25, 2]] as const) {
        const packets = recording(hz, 3, (t) => ({
          Steer: 50, AccelerationX: 8, AngularVelocityY: 0.32,
          Accel: (t >= 0.5 && t < 0.7) || (t >= secondStart && t < secondStart + 0.2) ? 255 : 0,
        }));
        expect(detectEarlyThrottle(packets)?.frameIndices).toHaveLength(expected);
        expect(detectBinaryThrottle(packets)?.frameIndices).toHaveLength(expected);
      }
    });

    test(`${hz} Hz: traction evidence distinguishes normal loaded power`, () => {
      const packets = recording(hz, 2, () => ({ Steer: 50, Accel: 180, AccelerationX: 8, AngularVelocityY: 0.32 }));
      expect(detectEarlyThrottle(packets, packets.map(() => grip))).toBeNull();
      const spin: AllWheelStates = { ...grip, rl: { state: "spin", slipRatio: 0.4 } };
      expect(detectEarlyThrottle(packets, packets.map(() => spin))?.frameIndices).toHaveLength(1);
    });

    test(`${hz} Hz: low throttle after stable unwind is an unquantified observation`, () => {
      const packets = exit(hz);
      const insight = detectDelayedThrottlePickup(packets, packets.map(() => grip));
      expect(insight?.severity).toBe("info");
      expect(insight?.frameIndices).toHaveLength(1);
      expect(insight?.timeLossS).toBeUndefined();
      expect(packets[insight!.frameIndices[0]].TimestampMS).toBeGreaterThan(1400);
      expect(packets[insight!.frameIndices[0]].TimestampMS).toBeLessThan(2600);
    });

    test(`${hz} Hz: loaded, rebraking, chicane, noisy and pit exits stay quiet`, () => {
      const variants: ((p: TelemetryPacket) => TelemetryPacket)[] = [
        (p) => p.TimestampMS > 1400 ? { ...p, AccelerationX: 8, AngularVelocityY: 0.32 } : p,
        (p) => p.TimestampMS > 1800 && p.TimestampMS < 2000 ? { ...p, Brake: 90 } : p,
        (p) => p.TimestampMS > 1800 && p.TimestampMS < 2000 ? { ...p, Steer: -35 } : p,
        (p) => p.TimestampMS > 1400 ? { ...p, Steer: Math.floor(p.TimestampMS / 100) % 2 ? 5 : 17 } : p,
        (p) => ({ ...p, iracing: { onPitRoad: true } as TelemetryPacket["iracing"] }),
      ];
      for (const variant of variants) expect(detectDelayedThrottlePickup(exit(hz).map(variant))).toBeNull();
      const packets = exit(hz);
      const spin: AllWheelStates = { ...grip, rr: { state: "spin", slipRatio: 0.4 } };
      expect(detectDelayedThrottlePickup(packets, packets.map(() => spin))).toBeNull();
    });

    test(`${hz} Hz: post-brake slowing never claims fault or quantified loss`, () => {
      const packets = recording(hz, 3, (t) => ({
        Brake: t < 0.5 ? 180 : 0,
        Accel: t >= 1.2 ? 180 : 0,
        Steer: 45,
        Speed: t < 0.5 ? 30 : t < 1.2 ? 30 - (t - 0.5) * 6 : 25.8 + (t - 1.2),
      }));
      for (const insight of [detectEarlyBraking(packets), detectOverSlowing(packets)]) {
        expect(insight?.severity).toBe("info");
        expect(insight?.frameIndices).toHaveLength(1);
        expect(insight?.timeLossS).toBeUndefined();
      }
    });

    test(`${hz} Hz: coasting severity uses elapsed time`, () => {
      expect(detectCoasting(recording(hz, 1.5, () => ({})))?.severity).toBe("info");
      expect(detectCoasting(recording(hz, 2.5, () => ({})))?.severity).toBe("warning");
    });
  }

  test("timestamp gap cannot join throttle application to its later correction", () => {
    const packets = recording(60, 3, (t) => ({
      Steer: 50, AccelerationX: 8, AngularVelocityY: 0.32,
      Accel: t >= 0.5 && t < 0.9 ? 255 : 0,
      TimestampMS: t * 1000 + (t >= 0.9 ? 2000 : 0),
    }));
    expect(detectBinaryThrottle(packets)).toBeNull();
    expect(detectEarlyThrottle(packets)).toBeNull();
  });

  test("timestamp gaps and brake transitions invalidate delayed pickup", () => {
    const packets = exit(60);
    expect(detectDelayedThrottlePickup(packets.map((p) => ({
      ...p, TimestampMS: p.TimestampMS + (p.TimestampMS >= 1800 ? 1000 : 0),
    })))).toBeNull();
    expect(detectDelayedThrottlePickup(packets.map((p) => p.TimestampMS >= 2800 ? { ...p, Brake: 80 } : p))).toBeNull();
  });
});
