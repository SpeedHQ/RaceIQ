import { describe, expect, test } from "bun:test";
import {
  detectBrakeDrag,
  detectDownshiftOverRev,
  detectKerbRiding,
  detectOversteerSlide,
  detectSteeringSawing,
  detectThrottleMicroLifts,
  detectUndersteerScrub,
} from "../../shared/racing/analysis/laps/insights/driving-advanced";
import { eventDurations, type TimeLossCtx } from "../../shared/racing/analysis/laps/insights/types";
import type { AllWheelStates } from "../../shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "../../shared/telemetry/types";

function samples(hz: number, seconds: number, values: (time: number) => Partial<TelemetryPacket>): TelemetryPacket[] {
  return Array.from({ length: Math.round(hz * seconds) }, (_, index) => ({
    TimestampMS: index * 1000 / hz,
    Speed: 30,
    Accel: 0,
    Brake: 0,
    Steer: 80,
    AccelerationX: 0,
    AngularVelocityY: 0,
    EngineMaxRpm: 8000,
    CurrentEngineRpm: 5000,
    Gear: 4,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    NormSuspensionTravelFL: 0.1,
    NormSuspensionTravelFR: 0.1,
    NormSuspensionTravelRL: 0.1,
    NormSuspensionTravelRR: 0.1,
    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    ...values(index / hz),
  } as TelemetryPacket));
}

function tractionContext(telemetry: TelemetryPacket[], spinning: (time: number) => boolean): TimeLossCtx {
  return {
    dt: eventDurations(telemetry),
    ref: { bins: [] },
    wheelStates: telemetry.map((packet): AllWheelStates => ({
      fl: { state: "grip", slipRatio: 0 },
      fr: { state: "grip", slipRatio: 0 },
      rl: { state: spinning(packet.TimestampMS / 1000) ? "spin" : "idle", slipRatio: 0.2 },
      rr: { state: spinning(packet.TimestampMS / 1000) ? "spin" : "idle", slipRatio: 0.2 },
    })),
  };
}

function liftThrottle(time: number): number {
  const phase = time % 1;
  if (phase < 0.2 || phase >= 0.36) return 255;
  if (phase < 0.24) return 255 - (phase - 0.2) * 3500;
  if (phase < 0.3) return 115;
  return 115 + (phase - 0.3) * (140 / 0.06);
}

describe("advanced insight elapsed-time contracts", () => {
  test("duration severity is invariant to telemetry rate", () => {
    for (const hz of [30, 60, 120]) {
      const drag = samples(hz, 3.5, () => ({ Accel: 255, Brake: 20 }));
      const understeer = samples(hz, 3.5, () => ({ TireSlipAngleFL: 0.3, TireSlipAngleFR: 0.3 }));
      const oversteer = samples(hz, 3.5, () => ({ TireSlipAngleRL: 0.3, TireSlipAngleRR: 0.3 }));
      expect(detectBrakeDrag(drag)?.severity).toBe("critical");
      expect(detectUndersteerScrub(understeer)?.severity).toBe("warning");
      expect(detectOversteerSlide(oversteer)?.severity).toBe("warning");
    }
  });

  test("downshift lookahead and cooldown are seconds, not sample counts", () => {
    for (const hz of [30, 60, 120]) {
      const telemetry = samples(hz, 2.2, (time) => ({
        Gear: time < 0.2 ? 4 : time < 0.65 ? 3 : time < 1.6 ? 2 : 1,
        CurrentEngineRpm: (time >= 0.45 && time < 0.52) || (time >= 0.85 && time < 0.92) || (time >= 1.85 && time < 1.92) ? 7900 : 5000,
      }));
      const insight = detectDownshiftOverRev(telemetry);
      expect(insight?.frameIndices).toHaveLength(2);
      const times = insight!.frameIndices.map((index) => telemetry[index].TimestampMS / 1000);
      expect(times[0]).toBeGreaterThanOrEqual(0.45);
      expect(times[0]).toBeLessThan(0.52);
      expect(times[1]).toBeGreaterThanOrEqual(1.85);
      expect(times[1]).toBeLessThan(1.92);

      const delayed = samples(hz, 1, (time) => ({ Gear: time < 0.2 ? 4 : 3, CurrentEngineRpm: time >= 0.65 ? 7900 : 5000 }));
      expect(detectDownshiftOverRev(delayed)).toBeNull();
    }
  });

  test("downshift RPM evidence cannot cross a telemetry gap", () => {
    const telemetry = samples(60, 1, (time) => ({
      TimestampMS: time * 1000 + (time >= 0.3 ? 1000 : 0),
      Gear: time < 0.2 ? 4 : 3,
      CurrentEngineRpm: time >= 0.4 ? 7900 : 5000,
    }));
    expect(detectDownshiftOverRev(telemetry)).toBeNull();
  });

  test("sawing uses steering rate and a one-second reversal window", () => {
    for (const hz of [30, 60, 120]) {
      const rapid = samples(hz, 2, (time) => ({ Steer: 80 + 30 * Math.sin(2 * Math.PI * 4 * time) }));
      const noise = samples(hz, 2, (time) => ({ Steer: 80 + 2 * Math.sin(2 * Math.PI * 8 * time) }));
      expect(detectSteeringSawing(rapid)?.frameIndices).toHaveLength(1);
      expect(detectSteeringSawing(noise)).toBeNull();
    }
  });

  test("sawing reversal counts reset at missing telemetry", () => {
    const telemetry = samples(60, 1.2, (time) => ({
      TimestampMS: time * 1000 + Math.floor(time / 0.3) * 1000,
      Steer: 80 + 30 * Math.sin(2 * Math.PI * 4 * time),
    }));
    expect(detectSteeringSawing(telemetry)).toBeNull();
  });

  test("smoothly sampled micro-lifts need nearby calibrated rear traction loss", () => {
    for (const hz of [30, 60, 120]) {
      const telemetry = samples(hz, 4, (time) => ({ Accel: liftThrottle(time) }));
      const insight = detectThrottleMicroLifts(telemetry, tractionContext(telemetry, () => true));
      expect(insight?.frameIndices).toHaveLength(4);
      expect(insight?.severity).toBe("info");
      expect(detectThrottleMicroLifts(telemetry)).toBeNull();
      expect(detectThrottleMicroLifts(telemetry, tractionContext(telemetry, () => false))).toBeNull();
      expect(detectThrottleMicroLifts(telemetry, tractionContext(telemetry, (time) => time % 1 >= 0.6))).toBeNull();
    }
  });

  test("moderate lifts require relative recovery rather than a low absolute trough", () => {
    for (const hz of [20, 60, 120]) {
      const moderate = samples(hz, 4, (time) => ({ Accel: time % 1 >= 0.2 && time % 1 < 0.3 ? 190 : 255 }));
      expect(detectThrottleMicroLifts(moderate, tractionContext(moderate, () => true))?.frameIndices).toHaveLength(4);
      const unrecovered = samples(hz, 4, (time) => ({ Accel: time % 1 >= 0.2 && time % 1 < 0.8 ? 190 : 255 }));
      expect(detectThrottleMicroLifts(unrecovered, tractionContext(unrecovered, () => true))).toBeNull();
    }
  });

  test("micro-lift recovery cannot bridge a telemetry gap", () => {
    const telemetry = samples(60, 4, (time) => ({
      Accel: liftThrottle(time),
      TimestampMS: time * 1000 + Math.floor(time) * 1000 + (time % 1 >= 0.25 ? 1000 : 0),
    }));
    expect(detectThrottleMicroLifts(telemetry, tractionContext(telemetry, () => true))).toBeNull();
  });

  test("kerb compression rate and duration are consistent across sample rates", () => {
    for (const hz of [30, 60, 120]) {
      for (const nativeRumble of [false, true]) {
        const telemetry = samples(hz, 3, (time) => {
          const phase = time % 1 - 0.2;
          const compression = phase < 0 || phase >= 0.1 ? 0 : phase < 0.05 ? phase * 15 : (0.1 - phase) * 15;
          return { NormSuspensionTravelFL: 0.1 + compression, WheelOnRumbleStripFL: nativeRumble && phase >= 0 && phase <= 0.1 ? 1 : 0 };
        });
        expect(detectKerbRiding(telemetry)?.frameIndices).toHaveLength(3);
        expect(detectKerbRiding(telemetry)?.severity).toBe("info");
      }
      const gradual = samples(hz, 3, (time) => ({ NormSuspensionTravelFL: 0.4 + 0.2 * Math.sin(2 * Math.PI * time), WheelOnRumbleStripFL: 1 }));
      expect(detectKerbRiding(gradual)).toBeNull();
    }
  });

  test("suspension displacement across missing telemetry is not a kerb strike", () => {
    const telemetry = samples(60, 4, (time) => ({
      TimestampMS: time * 1000 + Math.floor(time / 0.5) * 1000,
      NormSuspensionTravelFL: Math.floor(time / 0.5) % 2 === 0 ? 0.1 : 0.9,
    }));
    expect(detectKerbRiding(telemetry)).toBeNull();
  });
});
