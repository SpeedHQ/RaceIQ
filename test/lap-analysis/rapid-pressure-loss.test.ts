import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@shared/games/init";
import { analyzeLap } from "@shared/racing/analysis/laps/insights/analyze";
import { detectRapidPressureLoss, detectTirePressureImbalance } from "@shared/racing/analysis/laps/insights/tires";
import type { TelemetryPacket } from "@shared/telemetry/types";

initGameAdapters();

function pressureRun(values: (time: number) => Partial<TelemetryPacket>, hz = 60, duration = 14): TelemetryPacket[] {
  return Array.from({ length: Math.round(hz * duration) }, (_, index) => ({
    TimestampMS: index * 1000 / hz,
    IsRaceOn: 1,
    Speed: 40,
    Accel: 0,
    Brake: 0,
    Steer: 0,
    CurrentEngineRpm: 2_000,
    EngineMaxRpm: 8_000,
    WheelRotationSpeedFL: 120,
    WheelRotationSpeedFR: 120,
    WheelRotationSpeedRL: 120,
    WheelRotationSpeedRR: 120,
    TirePressureFrontLeft: 30,
    TirePressureFrontRight: 30,
    TirePressureRearLeft: 30,
    TirePressureRearRight: 30,
    TireTempFL: 90,
    TireTempFR: 90,
    TireTempRL: 90,
    TireTempRR: 90,
    TireWearFL: 0.2,
    TireWearFR: 0.2,
    TireWearRL: 0.2,
    TireWearRR: 0.2,
    NormSuspensionTravelFL: 0.5,
    NormSuspensionTravelFR: 0.5,
    NormSuspensionTravelRL: 0.5,
    NormSuspensionTravelRR: 0.5,
    Fuel: 10,
    Boost: 0,
    Power: 0,
    ...values(index / hz),
  } as TelemetryPacket));
}

function fallingPressure(time: number): number {
  return 30 - Math.min(4, Math.max(0, time - 5) * 4);
}

describe("rapid wheel-specific pressure loss", () => {
  test("detects a sustained loss with the same event timing at different sample rates", () => {
    for (const hz of [20, 60, 120]) {
      const samples = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time) }), hz);
      const insights = detectRapidPressureLoss(samples);
      expect(insights.map((insight) => [insight.id, insight.severity])).toEqual([["tire-rapid-pressure-loss-FL", "warning"]]);
      expect(insights[0].timeLossS).toBeUndefined();
      expect(insights[0].frameIndices).toHaveLength(1);
      expect(samples[insights[0].frameIndices[0]].TimestampMS / 1000).toBeCloseTo(6, 1);
    }
  });

  test("dispatches only for continuous direct pressure sources", () => {
    const samples = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time) }));
    expect(analyzeLap(samples, "acc").some((insight) => insight.id === "tire-rapid-pressure-loss-FL")).toBe(true);
    for (const game of ["iracing", "fm-2023"] as const) {
      expect(analyzeLap(samples, game).some((insight) => insight.id.startsWith("tire-rapid-pressure-loss-"))).toBe(false);
    }
  });

  test("ignores a short excursion and a sub-two-second low plateau", () => {
    const spike = pressureRun((time) => ({ TirePressureFrontLeft: time >= 6 && time < 6.1 ? 20 : 30 }));
    const brief = pressureRun((time) => ({ TirePressureFrontLeft: time >= 6 && time < 7.5 ? 26 : 30 }));
    expect(detectRapidPressureLoss(spike)).toEqual([]);
    expect(detectRapidPressureLoss(brief)).toEqual([]);
  });

  test("does not interpret common pressure cooling as a wheel-specific loss", () => {
    const samples = pressureRun((time) => {
      const pressure = fallingPressure(time);
      return { TirePressureFrontLeft: pressure, TirePressureFrontRight: pressure, TirePressureRearLeft: pressure, TirePressureRearRight: pressure };
    });
    expect(detectRapidPressureLoss(samples)).toEqual([]);
  });

  test("excludes wheel-local pressure cooling in Celsius and Fahrenheit", () => {
    for (const unit of ["celsius", "fahrenheit"] as const) {
      const samples = pressureRun((time) => {
        const pressure = fallingPressure(time);
        const temperature = (pressure + 14.7) / 44.7 * 363.15 - 273.15;
        return {
          TirePressureFrontLeft: pressure,
          TireTempFL: unit === "celsius" ? temperature : temperature * 1.8 + 32,
          TireTempFR: unit === "celsius" ? 90 : 194,
          TireTempRL: unit === "celsius" ? 90 : 194,
          TireTempRR: unit === "celsius" ? 90 : 194,
        };
      });
      expect(detectRapidPressureLoss(samples, unit)).toEqual([]);
    }
  });

  test("requires a fresh baseline after a pressure dropout", () => {
    for (const invalid of [NaN, 0, undefined]) {
      const samples = pressureRun((time) => ({ TirePressureFrontLeft: time >= 4.9 && time < 6.1 ? invalid : fallingPressure(time) }));
      expect(detectRapidPressureLoss(samples)).toEqual([]);
    }
  });

  test("does not bridge timestamp gaps or resets", () => {
    for (const offset of [2000, -5000]) {
      const samples = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time) }));
      for (const sample of samples) if (sample.TimestampMS >= 5000) sample.TimestampMS += offset;
      expect(detectRapidPressureLoss(samples)).toEqual([]);
    }
  });

  test("resets baseline on pit entry and tire-change evidence", () => {
    const inPits = pressureRun((time) => ({
      TirePressureFrontLeft: fallingPressure(time),
      acc: { pitStatus: time >= 4.9 && time < 7 ? "pit_lane" : "out" } as TelemetryPacket["acc"],
    }));
    const changedCompound = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time), TyreCompound: time < 5 ? 16 : 17 }));
    const renewedWear = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time), TireWearFL: time < 5 ? 0.2 : 0 }));
    expect(detectRapidPressureLoss(inPits)).toEqual([]);
    expect(detectRapidPressureLoss(changedCompound)).toEqual([]);
    expect(detectRapidPressureLoss(renewedWear)).toEqual([]);
  });

  test("slow pressure drift cannot qualify against an old baseline", () => {
    const samples = pressureRun((time) => ({ TirePressureFrontLeft: 30 - time / 10 }), 60, 40);
    expect(detectRapidPressureLoss(samples)).toEqual([]);
  });

  test("suppresses resulting imbalance while retaining unrelated axle evidence", () => {
    const samples = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time) }));
    const loss = detectRapidPressureLoss(samples);
    expect(detectTirePressureImbalance(samples)?.id).toBe("tire-pressure-imbalance");
    expect(detectTirePressureImbalance(samples, loss)).toBeNull();
    const rearImbalance = samples.map((sample) => ({ ...sample, TirePressureRearLeft: 33 }));
    expect(detectTirePressureImbalance(rearImbalance, loss)?.severity).toBe("critical");
  });

  test("keeps front imbalance that existed before a later front pressure loss", () => {
    const samples = pressureRun((time) => ({ TirePressureFrontLeft: fallingPressure(time) + 2 }));
    const loss = detectRapidPressureLoss(samples);
    expect(loss.map((insight) => insight.id)).toEqual(["tire-rapid-pressure-loss-FL"]);
    const imbalance = detectTirePressureImbalance(samples, loss);
    expect(imbalance?.severity).toBe("warning");
    expect(imbalance!.frameIndices[0]).toBeLessThan(loss[0].frameIndices[0]);
  });
});
