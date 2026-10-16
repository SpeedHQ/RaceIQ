import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { analyzeLap } from "@raceiq/analysis-core/racing/analysis/laps/insights/analyze";
import { eventDurations, groupEvents, INSIGHT_ORDER, insightsAt } from "@raceiq/analysis-core/racing/analysis/laps/insights/types";
import { detectBufferedInsights } from "@raceiq/analysis-core/racing/analysis/laps/insights/buffered-detectors";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { parseForzaPacket } from "@raceiq/game-fm-2023/parser";

initGameAdapters();

describe("sustained event evidence", () => {
  test("merged quiet gaps do not manufacture active duration", () => {
    const flags = [true, ...Array<boolean>(14).fill(false), true];
    expect(groupEvents(flags, flags.map(() => 1 / 60), 5 / 60, 15 / 60)).toEqual([]);
    expect(groupEvents([true, true, false, true, true], [0.1, 0.1, 0.1, 0.1, 0.1], 0.4, 0.1)).toEqual([[0, 4]]);
  });

  test("equal elapsed evidence survives resampling", () => {
    for (const hz of [20, 60, 120]) {
      const packets = Array.from({ length: hz }, (_, i) => ({ TimestampMS: i * 1000 / hz }) as TelemetryPacket);
      const flags = packets.map((_, i) => i < hz * 0.6);
      expect(groupEvents(flags, eventDurations(packets), 0.5)).toEqual([[0, hz * 0.6 - 1]]);
      expect(groupEvents(flags, eventDurations(packets), 0.7)).toEqual([]);
    }
  });

  test("a final-sample spike has no observed sustained duration", () => {
    const packets = [0, 50, 100].map((TimestampMS, index) => ({
      TimestampMS, Speed: 30, NormSuspensionTravelFL: index === 2 ? 1 : 0.5,
    }) as TelemetryPacket);
    expect(insightsAt(detectBufferedInsights(packets, eventDurations(packets), true), INSIGHT_ORDER.overload)).toEqual([]);
    packets.push({ TimestampMS: 150, Speed: 30, NormSuspensionTravelFL: 0.5 } as TelemetryPacket);
    expect(insightsAt(detectBufferedInsights(packets, eventDurations(packets), true), INSIGHT_ORDER.overload).map((insight) => insight.id)).toEqual(["susp-overload-FL"]);
  });

  test("clock gaps, duplicates and resets split evidence", () => {
    for (const discontinuity of [1000, 200, 0]) {
      const packets = [0, 100, 200, discontinuity, discontinuity + 100, discontinuity + 200]
        .map((TimestampMS) => ({ TimestampMS }) as TelemetryPacket);
      expect(groupEvents(packets.map(() => true), eventDurations(packets), 0.4, 1)).toEqual([]);
    }
  });
});

test("Forza parser steering reaches normalized metrics as centered signed input", () => {
  const raw = Buffer.alloc(331);
  raw.writeInt32LE(1, 0);
  const steerMagnitude = (steer: number) => {
    raw.writeInt8(steer, 308);
    const packet = parseForzaPacket(raw)!;
    const center = 0;
    const range = 127;
    return Math.abs((packet.Steer - center) / range);
  };
  expect(steerMagnitude(0)).toBe(0);
  expect(steerMagnitude(-64)).toBeCloseTo(steerMagnitude(64), 8);
  expect(steerMagnitude(127)).toBe(1);
});

test("display-scaled Evo suspension cannot claim physical end-stop overload", () => {
  const raw = Buffer.alloc(331);
  raw.writeInt32LE(1, 0);
  const template = parseForzaPacket(raw)!;
  const packets = Array.from({ length: 120 }, (_, i) => ({
    ...template, TimestampMS: i * 1000 / 60, Speed: 30, EngineMaxRpm: 9000,
    CurrentEngineRpm: 4000, Accel: 100, Gear: 3,
    NormSuspensionTravelFL: 1, NormSuspensionTravelFR: 1,
    NormSuspensionTravelRL: 1, NormSuspensionTravelRR: 1,
  }));
  expect(analyzeLap(packets, "ac-evo").filter((insight) => insight.id.startsWith("susp-overload-"))).toEqual([]);
  expect(analyzeLap(packets, "fm-2023").filter((insight) => insight.id.startsWith("susp-overload-")).map((insight) => insight.id))
    .toEqual(["susp-overload-FL", "susp-overload-FR", "susp-overload-RL", "susp-overload-RR"]);
});
