import { expect, test } from "bun:test";
import { detectBufferedInsights } from "@shared/racing/analysis/laps/insights/buffered-detectors";
import { eventDurations, INSIGHT_ORDER, insightAt, insightsAt } from "@shared/racing/analysis/laps/insights/types";
import type { AllWheelStates, WheelState } from "@shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "@shared/telemetry/types";

test("buffered detectors preserve event gaps, final event, and independent lap aggregates", () => {
  const telemetry = Array.from({ length: 140 }, (_, i) => ({
    TimestampMS: i * 50,
    Speed: 30,
    Brake: 0,
    Steer: i < 3 || i >= 138 ? -40 : 0,
    AngularVelocityY: 0.5,
    AccelerationX: 0,
    NormSuspensionTravelFL: i < 3 || i >= 138 ? 0.98 : 0.7,
    NormSuspensionTravelFR: 0.4,
    NormSuspensionTravelRL: 0.7,
    NormSuspensionTravelRR: 0.4,
    Power: i === 100 ? 149140 : 0,
    CurrentEngineRpm: 6000,
    Gear: 4,
  })) as TelemetryPacket[];

  const result = detectBufferedInsights(telemetry, eventDurations(telemetry), true);
  expect(insightsAt(result, INSIGHT_ORDER.overload).map(({ id, severity, frameIndices }) => ({ id, severity, frameIndices }))).toEqual([
    { id: "susp-overload-FL", severity: "warning", frameIndices: [1, 138] },
  ]);
  expect(insightAt(result, INSIGHT_ORDER.imbalance)?.detail).toContain("left side compressed 30% more");
  expect(insightAt(result, INSIGHT_ORDER.counterSteer)?.frameIndices).toEqual([1, 138]);
  expect(insightAt(result, INSIGHT_ORDER.counterSteer)?.severity).toBe("warning");
  expect(insightAt(result, INSIGHT_ORDER.peakPower)?.frameIndices).toEqual([100]);
  expect(insightAt(result, INSIGHT_ORDER.peakPower)?.detail).toBe("200 hp @ 6000 RPM (gear 4)");
  const withoutSuspension = detectBufferedInsights(telemetry, eventDurations(telemetry), false);
  expect(insightsAt(withoutSuspension, INSIGHT_ORDER.overload)).toEqual([]);
  expect(insightAt(withoutSuspension, INSIGHT_ORDER.imbalance)).toBeNull();
  expect(insightAt(withoutSuspension, INSIGHT_ORDER.counterSteer)?.frameIndices).toEqual([1, 138]);
});

test("wheel events share buffered traversal without counting uncalibrated or final samples", () => {
  const packets = Array.from({ length: 140 }, (_, i) => ({
    TimestampMS: i * 50,
    Speed: 30,
    Brake: i < 5 ? 40 : 0,
    Accel: i >= 135 ? 200 : 0,
  })) as TelemetryPacket[];
  const grip: WheelState = { state: "grip", slipRatio: 0 };
  const lockup: WheelState = { state: "lockup", slipRatio: -0.5 };
  const spin: WheelState = { state: "spin", slipRatio: 0.5 };
  const wheelStates: AllWheelStates[] = packets.map((_, i) => ({
    fl: i < 5 ? lockup : grip,
    fr: grip,
    rl: i >= 135 ? spin : grip,
    rr: grip,
  }));
  const result = detectBufferedInsights(packets, eventDurations(packets), false, wheelStates);
  expect(insightsAt(result, INSIGHT_ORDER.lockups).map(({ id, severity, frameIndices }) => ({ id, severity, frameIndices }))).toEqual([
    { id: "tire-lockup-FL", severity: "warning", frameIndices: [2] },
  ]);
  expect(insightsAt(result, INSIGHT_ORDER.wheelspin).map(({ id, severity, frameIndices }) => ({ id, severity, frameIndices }))).toEqual([
    { id: "tire-spin-RL", severity: "warning", frameIndices: [137] },
  ]);
  expect(insightAt(result, INSIGHT_ORDER.brakeTractionLoss)?.frameIndices).toEqual([2]);
  expect(insightAt(result, INSIGHT_ORDER.throttleTractionLoss)?.frameIndices).toEqual([137]);
  expect(insightsAt(detectBufferedInsights(packets, eventDurations(packets), false), INSIGHT_ORDER.lockups)).toEqual([]);
});
