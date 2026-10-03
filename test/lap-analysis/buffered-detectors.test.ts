import { expect, test } from "bun:test";
import { detectBufferedInsights } from "@raceiq/shared/racing/analysis/laps/insights/buffered-detectors";
import { eventDurations, INSIGHT_ORDER, insightAt, insightsAt } from "@raceiq/shared/racing/analysis/laps/insights/types";
import type { AllWheelStates, WheelState } from "@raceiq/shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";

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
  expect(insightAt(result, INSIGHT_ORDER.peakPower)?.frameIndices).toEqual([100]);
  expect(insightAt(result, INSIGHT_ORDER.peakPower)?.detail).toBe("200 hp @ 6000 RPM (gear 4)");
  const withoutSuspension = detectBufferedInsights(telemetry, eventDurations(telemetry), false);
  expect(insightsAt(withoutSuspension, INSIGHT_ORDER.overload)).toEqual([]);
  expect(insightAt(withoutSuspension, INSIGHT_ORDER.imbalance)).toBeNull();
});

test("counter-steer needs a reversal against continuing turn rotation, not ordinary cornering or rear slip alone", () => {
  const packets = Array.from({ length: 40 }, (_, i) => ({
    TimestampMS: i * 50,
    Speed: 30,
    Steer: i < 12 ? 50 : i < 16 ? -40 : 0,
    AngularVelocityY: i < 16 ? -0.5 : 0,
    AccelerationX: i < 16 ? 8 : 0,
  })) as TelemetryPacket[];
  const counterSteer = (trace: TelemetryPacket[]) =>
    insightAt(detectBufferedInsights(trace, eventDurations(trace), false), INSIGHT_ORDER.counterSteer);

  expect(counterSteer(packets)?.frameIndices).toEqual([12]);
  const reversedAxis = packets.map((packet) => ({ ...packet, Steer: -packet.Steer }));
  expect(counterSteer(reversedAxis)?.frameIndices).toEqual([12]);
  const ambiguousAxis = packets.map((packet, i) => ({
    ...packet, AccelerationX: i % 2 ? -packet.AccelerationX : packet.AccelerationX,
  }));
  expect(counterSteer(ambiguousAxis)).toBeNull();
  const interrupted = packets.map((packet, i) => ({
    ...packet,
    Steer: i < 20 ? 50 : i < 22 ? -40 : i < 24 ? 0 : i < 28 ? -60 : 0,
    AngularVelocityY: i < 28 ? -0.5 : 0,
    AccelerationX: i < 28 ? 8 : 0,
  }));
  const event = counterSteer(interrupted);
  expect(event?.frameIndices).toHaveLength(1);
  expect(interrupted[event!.frameIndices[0]].Steer).toBeLessThan(-50);
  expect(counterSteer(packets.map((packet) => ({ ...packet, Steer: Math.abs(packet.Steer) })))).toBeNull();
  expect(counterSteer(packets.map((packet, i) => ({
    ...packet, AngularVelocityY: i >= 12 && i < 16 ? 0.5 : packet.AngularVelocityY,
    AccelerationX: i >= 12 && i < 16 ? -8 : packet.AccelerationX,
  })))).toBeNull();
  expect(counterSteer(packets.map((packet, i) => ({
    ...packet, TimestampMS: packet.TimestampMS + (i >= 12 ? 1000 : 0),
  })))).toBeNull();
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
