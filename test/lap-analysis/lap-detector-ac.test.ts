import { describe, test, expect, afterAll } from "bun:test";
import { parseDump } from "../support/recordings/parse-dump";
import { LapDetectorAcc } from "../../server/games/acc/lap-detector"
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline"
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { PersistLapInput } from "../../server/db/lap-mutation-queries";

initGameAdapters();

afterAll(() => stopMaintenanceTasks());

// Fake DB stub — v2 should only call insertLap / getTuneAssignment / insertSession
function makeFakeDb() {
  const inserted: Array<{ lapNumber: number; lapTime: number; valid: boolean; invalidReason: string | null; phase: string; paceEligibility: string }> = [];
  return {
    inserted,
    insertSession: async () => 1,
    insertLap: async (input: PersistLapInput) => {
      inserted.push({
        lapNumber: input.lapNumber,
        lapTime: input.lapTime,
        valid: input.isValid,
        invalidReason: input.invalidReason,
        phase: input.classification?.phase ?? "flying",
        paceEligibility: input.classification?.paceEligibility ?? "eligible",
      });
      return inserted.length;
    },
    getTuneAssignment: async () => null,
    getTrackOutlineSectors: async () => null,
    // These fake laps never carry a tuning session / tune, so
    // reconcileAutoExclusionsForLap (server/experiments/auto-exclude.ts) always
    // no-ops after seeing null/null here.
    getLapExperimentScope: async () => ({ experimentId: null, tuneId: null }),
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

describe("LapDetectorAc — reset detection", () => {
  test("emits a lap when CurrentLap resets from >30 to <2", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorAcc({
      db,
      callbacks: {
        onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime }),
      },
    });

    // Drive a fake lap: CurrentLap climbs 0 -> 90, DistanceTraveled accumulates
    for (let t = 0; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    // Reset: CurrentLap drops, DistanceTraveled keeps climbing
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    expect(saved.length).toBe(1);
    expect(saved[0].lapNumber).toBe(1);
    expect(saved[0].lapTime).toBeCloseTo(90, 0);
  });

  test("fires onLapComplete with lap event when a lap is emitted", async () => {
    const db = makeFakeDb();
    const completeEvents: Array<{
      packetCount: number;
      lapDistStart: number;
      lapTime: number;
      isValid: boolean;
    }> = [];
    const d = new LapDetectorAcc({
      db,
      callbacks: {
        onLapComplete: (e) =>
          completeEvents.push({
            packetCount: e.packets.length,
            lapDistStart: e.lapDistStart,
            lapTime: e.lapTime,
            isValid: e.isValid,
          }),
      },
    });

    // Drive one fake lap, then reset to trigger emission
    for (let t = 0; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: 1000 + t * 50, TimestampMS: t * 1000 }));
    }
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 1000 + 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    expect(completeEvents.length).toBe(1);
    expect(completeEvents[0].packetCount).toBeGreaterThan(0);
    expect(completeEvents[0].lapDistStart).toBe(1000);
    expect(completeEvents[0].lapTime).toBeCloseTo(90, 0);
  });

  test("does not fire onLapComplete for silent incomplete-flush events", async () => {
    const db = makeFakeDb();
    let completeCount = 0;
    const d = new LapDetectorAcc({
      db,
      callbacks: {
        onLapComplete: () => completeCount++,
      },
    });

    // Drive a partial in-progress lap, then flush
    for (let t = 0; t <= 30; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    await d.flushIncompleteLap();

    expect(completeCount).toBe(0);
  });

  test("keeps a partial initial pit lap telemetry-valid", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({ db });

    // Recording starts with the car in the pit lane, ~50s into some pre-recording lap
    for (let t = 50; t <= 70; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "pit_lane" } as any,
        })
      );
    }
    // Driver exits the pit lane partway through and spends the rest of the pre-recording lap on track
    for (let t = 71; t <= 90; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "out" } as any,
        })
      );
    }
    // First reset (end of that pre-recording lap) — on track now
    await d.feed(
      packet({
        CurrentLap: 0.3,
        DistanceTraveled: 90 * 50 + 30,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "out" } as any,
      })
    );

    // Full clean lap on track
    for (let t = 1; t <= 85; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: 90 * 50 + 30 + t * 50,
          TimestampMS: (91 + t) * 1000,
          acc: { pitStatus: "out" } as any,
        })
      );
    }
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 999999,
        TimestampMS: 999999,
        acc: { pitStatus: "out" } as any,
      })
    );

    // Two laps: partial outlap pace plus full clean lap.
    expect(db.inserted).toHaveLength(2);
    expect(db.inserted[0]).toMatchObject({
      lapNumber: 1,
      valid: true,
      invalidReason: null,
    });
    expect(db.inserted[1]).toMatchObject({
      lapNumber: 2,
      valid: true,
    });
    expect(db.inserted[1].lapTime).toBeCloseTo(85, 0);
  });

  test("session restart (distance reset) discards in-progress lap and keeps new packet", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorAcc({
      db,
      callbacks: {
        onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime }),
      },
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
    expect(saved[0].lapNumber).toBe(1);
    expect(saved[0].lapTime).toBeCloseTo(80, 0);
  });

  test("calls assessLapRecording and marks short-distance laps invalid", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number; isValid: boolean }> = [];
    const d = new LapDetectorAcc({
      db,
      callbacks: {
        onLapSaved: (n) => saved.push({ lapNumber: n.lapNumber, lapTime: n.lapTime, isValid: n.isValid }),
      },
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

  test("keeps ACC outlap telemetry validity separate from pit classification", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({ db });

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

    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      valid: true,
      invalidReason: null,
    });
  });

  test("keeps ACC inlap telemetry validity separate from pit classification", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({ db });

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

    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]).toMatchObject({
      valid: true,
      invalidReason: null,
    });
  });
});

test("parseDump runs against the problem recording without throwing", async () => {
  const result = await parseDump("acc", "test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz");
  expect(result.laps.length).toBeGreaterThan(0);
}, { timeout: 30000 });

test("session bin: laps 1+2 have no isValidLap=false, laps 3+4 contain isValidLap=false frames", async () => {
  const result = await parseDump("acc", "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz");
  const byLap = new Map(result.laps.map((l) => [l.lapNumber, l]));
  expect(byLap.get(1)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(false);
  expect(byLap.get(2)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(false);
  expect(byLap.get(3)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(true);
  expect(byLap.get(4)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(true);
}, { timeout: 60000 });
