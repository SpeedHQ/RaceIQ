import { describe, test, expect } from "bun:test";
import { LapDetectorV2 } from "../server/lap-detector-v2";
import type { TelemetryPacket } from "../shared/types";

// Fake DB stub — v2 should only call insertLap / getTuneAssignment / insertSession
function makeFakeDb() {
  const inserted: Array<{ lapNumber: number; lapTime: number; valid: boolean }> = [];
  return {
    inserted,
    insertSession: async () => 1,
    insertLap: async (_s: number, lapNumber: number, lapTime: number, valid: boolean) => {
      inserted.push({ lapNumber, lapTime, valid });
      return inserted.length;
    },
    getTuneAssignment: async () => null,
    getTrackOutlineSectors: async () => null,
  } as any;
}

function packet(fields: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "acc",
    CarOrdinal: 34,
    TrackOrdinal: 2,
    CarPerformanceIndex: 0,
    CarClass: 0,
    LapNumber: 0,
    CurrentLap: 0,
    LastLap: 0,
    BestLap: 0,
    CurrentRaceTime: 0,
    DistanceTraveled: 0,
    PositionX: 0,
    PositionY: 0,
    PositionZ: 0,
    Speed: 0,
    TimestampMS: 0,
    ...fields,
  } as TelemetryPacket;
}

describe("LapDetectorV2 — reset detection", () => {
  test("emits a lap when CurrentLap resets from >30 to <2", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorV2({
      db,
      onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime }),
    });

    // Drive a fake lap: CurrentLap climbs 0 -> 90, DistanceTraveled accumulates
    for (let t = 0; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    // Reset: CurrentLap drops, DistanceTraveled keeps climbing
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    expect(saved.length).toBe(1);
    expect(saved[0].lapNumber).toBe(0);
    expect(saved[0].lapTime).toBeCloseTo(90, 0);
  });

  test("discards partial initial lap when recording starts mid-lap", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorV2({
      db,
      onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime }),
    });

    // Recording starts with the car already 50s into a lap
    for (let t = 50; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    // First reset — this partial "lap" must be discarded
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    // Full clean lap
    for (let t = 1; t <= 85; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: 90 * 50 + 30 + t * 50, TimestampMS: (91 + t) * 1000 }));
    }
    await d.feed(packet({ CurrentLap: 0.2, DistanceTraveled: 999999, TimestampMS: 999999 }));

    expect(saved.length).toBe(1);
    expect(saved[0].lapNumber).toBe(0); // first *real* lap is numbered 0
    expect(saved[0].lapTime).toBeCloseTo(85, 0);
  });

  test("session restart (distance reset) discards in-progress lap and keeps new packet", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorV2({
      db,
      onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime }),
    });

    // Drive 20 seconds into lap 0 (distance accumulating)
    for (let t = 0; t <= 20; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    // Restart: distance drops back to ~0, CurrentLap also near 0
    await d.feed(packet({ CurrentLap: 0.1, DistanceTraveled: 0, TimestampMS: 100000 }));

    // No lap should have been emitted
    expect(saved.length).toBe(0);

    // The new packet IS the start of the post-restart lap; drive a full lap from here
    for (let t = 1; t <= 80; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: (100 + t) * 1000 }));
    }
    // Complete that lap
    await d.feed(packet({ CurrentLap: 0.2, DistanceTraveled: 80 * 50 + 30, TimestampMS: 200000 }));

    expect(saved.length).toBe(1);
    expect(saved[0].lapNumber).toBe(0);
    expect(saved[0].lapTime).toBeCloseTo(80, 0);
  });
});
