import { describe, test, expect } from "bun:test";
import { parseDumpV2 } from "./helpers/parse-dump-v2";
import { LapDetectorV2 } from "../server/lap-detector-v2";
import type { TelemetryPacket } from "../shared/types";

// Fake DB stub — v2 should only call insertLap / getTuneAssignment / insertSession
function makeFakeDb() {
  const inserted: Array<{ lapNumber: number; lapTime: number; valid: boolean; invalidReason: string | null }> = [];
  return {
    inserted,
    insertSession: async () => 1,
    insertLap: async (
      _sessionId: number,
      lapNumber: number,
      lapTime: number,
      valid: boolean,
      _packets: unknown,
      _a: unknown,
      _b: unknown,
      invalidReason: string | null,
      _sectors: unknown
    ) => {
      inserted.push({ lapNumber, lapTime, valid, invalidReason });
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

  test("saves partial initial lap as invalid when recording starts mid-lap", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number; isValid: boolean; invalidReason: string | null }> = [];
    const d = new LapDetectorV2({
      db,
      onLapSaved: (n) =>
        saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime, isValid: n.isValid, invalidReason: (n as any).invalidReason ?? null }),
    });

    // Recording starts with the car already 50s into a lap
    for (let t = 50; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    // First reset — this partial "lap" should be saved as invalid
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    // Full clean lap
    for (let t = 1; t <= 85; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: 90 * 50 + 30 + t * 50, TimestampMS: (91 + t) * 1000 }));
    }
    await d.feed(packet({ CurrentLap: 0.2, DistanceTraveled: 999999, TimestampMS: 999999 }));

    // Two laps: the partial joining lap (invalid) and the full clean lap (valid)
    expect(saved.length).toBe(2);
    expect(saved[0].lapNumber).toBe(0);
    expect(saved[0].isValid).toBe(false);
    expect(saved[1].lapNumber).toBe(1);
    expect(saved[1].isValid).toBe(true);
    expect(saved[1].lapTime).toBeCloseTo(85, 0);
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

  test("calls assessLapRecording and marks short-distance laps invalid", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number; isValid: boolean }> = [];
    const d = new LapDetectorV2({
      db,
      onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime, isValid: n.isValid }),
    });

    // 50 packets with DistanceTraveled increasing only ~50m total — fails the "lapDistance < 100" rule
    for (let t = 0; t <= 50; t += 1) {
      await d.feed(packet({ CurrentLap: t * 2, DistanceTraveled: t * 1, TimestampMS: t * 100 }));
    }
    // Reset
    await d.feed(packet({ CurrentLap: 0.1, DistanceTraveled: 52, TimestampMS: 51000 }));

    expect(saved.length).toBe(1);
    expect(saved[0].isValid).toBe(false);
  });

  test("marks ACC lap invalid with reason 'pit lap' when it starts in the pit lane", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorV2({ db });

    // Out-lap: starts in pit lane, exits to track, drives a full clean lap
    // First packet: CurrentLap=0, pitStatus=pit_lane (car in pit exit)
    await d.feed(
      packet({
        CurrentLap: 0,
        DistanceTraveled: 0,
        TimestampMS: 0,
        acc: { pitStatus: "pit_lane" } as any,
      })
    );
    // Next 40 packets: still in pit lane, creeping towards track
    for (let t = 1; t <= 40; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "pit_lane" } as any,
        })
      );
    }
    // Car exits pit, on track for the rest of the lap
    for (let t = 41; t <= 90; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "out" } as any,
        })
      );
    }
    // Lap boundary — reset
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 91 * 50,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "out" } as any,
      })
    );

    expect(db.inserted.length).toBe(1);
    expect(db.inserted[0].valid).toBe(false);
    expect(db.inserted[0].invalidReason).toBe("pit lap");
  });

  test("marks ACC lap invalid with reason 'pit lap' when it ends in the pit lane", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorV2({ db });

    // In-lap: drives most of the lap on track, enters pit lane near the finish
    for (let t = 0; t <= 60; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "out" } as any,
        })
      );
    }
    // Enters pit lane for the last ~30s of the lap
    for (let t = 61; t <= 90; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "pit_lane" } as any,
        })
      );
    }
    // Lap boundary — reset, still in pit
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 91 * 50,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "pit_lane" } as any,
      })
    );

    expect(db.inserted.length).toBe(1);
    expect(db.inserted[0].valid).toBe(false);
    expect(db.inserted[0].invalidReason).toBe("pit lap");
  });
});

test("parseDumpV2 runs against the problem recording without throwing", async () => {
  const result = await parseDumpV2("acc", "test/artifacts/laps/acc-2026-04-10T02-59-28-972Z.bin");
  expect(result.laps.length).toBeGreaterThan(0);
}, { timeout: 30000 });
