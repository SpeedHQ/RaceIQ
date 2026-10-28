import { describe, expect, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { getPacketTireCompound, getTireCompoundOptions, getTireCoreTempRange, getTireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import type { TireThresholds } from "@raceiq/shared/racing/live/tire-thresholds";
import { PitTracker } from "@raceiq/race-strategy/server";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";

initGameAdapters();

const packet = (frontTireCompound: string, rearTireCompound: string): TelemetryPacket => ({
  gameId: "lmu",
  carId: "car",
  trackId: "track",
  LapNumber: 1,
  CurrentLap: 0,
  Fuel: 50,
  DistanceTraveled: 100,
  TireWearFL: 0.2,
  TireWearFR: 0.2,
  TireWearRL: 0.2,
  TireWearRR: 0.2,
  lmu: { frontTireCompound, rearTireCompound },
} as unknown as TelemetryPacket);

const kunosPacket = (gameId: "acc" | "ac-evo", tireCompound: string): TelemetryPacket => ({
  ...packet("", ""),
  gameId,
  acc: { tireCompound },
} as unknown as TelemetryPacket);

const kunosOverrides = {
  acc: {
    dry_compound: { cliffPct: 45, deadPct: 15 },
    wet_compound: { cliffPct: 70, deadPct: 30 },
  },
  "ac-evo": {
    dry_compound: { cliffPct: 45, deadPct: 15 },
    wet_compound: { cliffPct: 70, deadPct: 30 },
  },
};

test("native Kunos presets resolve and project independently for ACC and AC Evo", () => {
  for (const gameId of ["acc", "ac-evo"] as const) {

    for (const compound of ["dry_compound", "wet_compound"] as const) {
      expect(getTireCompoundOptions(gameId)).toContain(compound);
      const frame = kunosPacket(gameId, compound);
      const thresholds = [0, 1, 2, 3].map((wheel) =>
        getTireThresholds(kunosOverrides, gameId, getPacketTireCompound(frame, wheel))
      ) as [TireThresholds, TireThresholds, TireThresholds, TireThresholds];
      const tracker = new PitTracker();
      tracker._seedForTest([], [{ fl: 0.1, fr: 0.1, rl: 0.1, rr: 0.1 }]);

      const pit = tracker.feed(frame, 1000, 0, thresholds);
      const cliffLaps = compound === "dry_compound" ? 3.5 : 1;
      const deadLaps = compound === "dry_compound" ? 6.5 : 5;
      expect(pit.tireEstimates.toCliff).toEqual([cliffLaps, cliffLaps, cliffLaps, cliffLaps]);
      expect(pit.tireEstimates.toDead).toEqual([deadLaps, deadLaps, deadLaps, deadLaps]);
      expect(pit.pitInLaps).toBe(cliffLaps);
    }

  }
});

const overrides = {
  lmu: {
    soft: { cliffPct: 50, deadPct: 0 },
    hard: { cliffPct: 30, deadPct: 20 },
    default: { cliffPct: 65, deadPct: 25 },
  },
};

const resolved = (frame: TelemetryPacket): [TireThresholds, TireThresholds, TireThresholds, TireThresholds] => [
  getTireThresholds(overrides, "lmu", getPacketTireCompound(frame, 0)),
  getTireThresholds(overrides, "lmu", getPacketTireCompound(frame, 1)),
  getTireThresholds(overrides, "lmu", getPacketTireCompound(frame, 2)),
  getTireThresholds(overrides, "lmu", getPacketTireCompound(frame, 3)),
];

describe("per-wheel tire thresholds", () => {
  test("resolves mixed LMU axles, preserves zero-dead, and changes on compound switch", () => {
    const frame = packet("Soft", "Hard");
    const thresholds = resolved(frame);
    expect([0, 1, 2, 3].map((wheel) => getPacketTireCompound(frame, wheel))).toEqual(["soft", "soft", "hard", "hard"]);
    expect(thresholds).toEqual([
      { cliffPct: 50, deadPct: 0 },
      { cliffPct: 50, deadPct: 0 },
      { cliffPct: 30, deadPct: 20 },
      { cliffPct: 30, deadPct: 20 },
    ]);

    const tracker = new PitTracker();
    tracker._seedForTest([], [{ fl: 0.1, fr: 0.1, rl: 0.1, rr: 0.1 }]);
    const pit = tracker.feed(frame, 1000, 0, thresholds);
    expect(pit.tireEstimates.toCliff).toEqual([3, 3, 5, 5]);
    expect(pit.tireEstimates.toDead).toEqual([8, 8, 6, 6]);
    expect(pit.tireThresholds).toEqual(thresholds);

    frame.lmu!.rearTireCompound = "Soft";
    expect(resolved(frame)).toEqual([
      { cliffPct: 50, deadPct: 0 },
      { cliffPct: 50, deadPct: 0 },
      { cliffPct: 50, deadPct: 0 },
      { cliffPct: 50, deadPct: 0 },
    ]);
  });

  test("unknown LMU compound uses only default override", () => {
    const frame = packet("unknown", "  ");
    expect([getPacketTireCompound(frame, 0), getPacketTireCompound(frame, 2)]).toEqual(["default", "default"]);
    expect(resolved(frame)).toEqual([
      { cliffPct: 65, deadPct: 25 },
      { cliffPct: 65, deadPct: 25 },
      { cliffPct: 65, deadPct: 25 },
      { cliffPct: 65, deadPct: 25 },
    ]);
  });
});

describe("per-compound optimal core range", () => {
  test("resolves dry and wet windows from game metadata", () => {
    expect(getTireCoreTempRange("acc", "dry_compound")).toEqual({ min: 70, max: 100 });
    expect(getTireCoreTempRange("acc", "wet_compound")).toEqual({ min: 50, max: 70 });
    expect(getTireCoreTempRange("acc", "DEFAULT")).toEqual({ min: 70, max: 100 });
    expect(getTireCoreTempRange("f1-2025", "soft")).toEqual({ min: 75, max: 95 });
    expect(getTireCoreTempRange("f1-2025", "inter")).toEqual({ min: 60, max: 80 });
    expect(getTireCoreTempRange("f1-2025", "wet")).toEqual({ min: 50, max: 70 });
    expect(getTireCoreTempRange("ac-evo", "dry_compound")).toEqual({ min: 75, max: 100 });
  });

  test("falls back to the game's primary temperature bands without metadata", () => {
    expect(getTireCoreTempRange("lmu", "default")).toEqual({ min: 70, max: 105 });
    expect(getTireCoreTempRange("fm-2023", "default")).toEqual({ min: 75, max: 115 });
  });
});
