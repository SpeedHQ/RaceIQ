import { describe, test, expect, afterAll } from "bun:test";
import { parseDump } from "../support/recordings/parse-dump";
import { LapDetectorAcc } from "../../server/games/acc/lap-detector";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import type { LapClassification } from "../../shared/racing/laps/classification";
import type { PersistLapInput } from "../../server/db/lap-mutation-queries";
import type { DbAdapter } from "../../server/telemetry/pipeline-ports";
import type { EligibilityDecisionSet, LapQualitySummary } from "../../shared/racing/quality/contracts";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import {
  EMPTY_LAP_TIMELINE_CONTEXT,
  type LapTimelineContextProvider,
} from "../../server/lap-detection/types";

afterAll(() => stopMaintenanceTasks());
initGameAdapters();
initServerGameAdapters();

function timelineWithPitPhases(
  phases: Readonly<Record<number, "out" | "in" | "pit">>,
): LapTimelineContextProvider {
  return {
    classificationForLap: (_sessionId, lapNumber) => ({
      pitPhase: phases[lapNumber] ?? null,
      conditions: [],
      gridStart: false,
    }),
    eventIdsForLap: () => [],
  };
}

// Fake DB stub captures lap validity separately from pace classification.
type CapturedLap = {
  lapNumber: number;
  lapTime: number;
  valid: boolean;
  invalidReason: string | null;
  rawByteOffset: number | null;
  rawFrameCount: number;
  quality: LapQualitySummary;
  eligibility: EligibilityDecisionSet;
} & LapClassification;

function makeFakeDb(): DbAdapter & { inserted: CapturedLap[] } {
  const inserted: CapturedLap[] = [];
  return {
    inserted,
    insertSession: async () => 1,
    insertLap: async (input: PersistLapInput) => {
      inserted.push({
        lapNumber: input.lapNumber,
        lapTime: input.lapTime,
        valid: input.isValid,
        invalidReason: input.invalidReason,
        rawByteOffset: input.rawByteOffset,
        rawFrameCount: input.rawFrameCount,
        quality: input.quality!,
        eligibility: input.eligibility!,
        ...input.classification,
      });
      return inserted.length;
    },
    getTuneAssignment: async () => null,
    getTrackOutlineSectors: async () => null,
    // These fake laps never carry a tuning session / tune, so
    // reconcileAutoExclusionsForLap (server/experiments/auto-exclude.ts) always
    // no-ops after seeing null/null here.
    getLapExperimentScope: async () => ({ experimentId: null, tuneId: null }),
  } as unknown as DbAdapter & { inserted: CapturedLap[] };
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
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      callbacks: {
        onLapSaved: (event) => {
          saved.push({ lapNumber: event.lapNumber, lapTime: event.lapTime });
        },
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
    expect(db.inserted[0].quality.sourceKind).toBe("native-live");
    expect(db.inserted[0].quality.provenance.outputGeneration).toBeTruthy();
    expect(db.inserted[0].eligibility["official-timing"].status).not.toBe("unknown");
  });

  test("publishes first saved lap after completing its own issue eligibility", async () => {
    const db = makeFakeDb();
    const callbackOrder: Array<"complete" | "saved"> = [];
    let pendingIssueEligibility: EligibilityDecisionSet | null = null;
    const completeEvents: Array<{
      packetCount: number;
      lapDistStart: number;
      lapTime: number;
      isValid: boolean;
      eligibility: EligibilityDecisionSet;
    }> = [];
    const savedEvents: Array<{
      lapNumber: number;
      lapTime: number;
      eligibility: EligibilityDecisionSet;
      issueEligibility: EligibilityDecisionSet | null;
    }> = [];
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      callbacks: {
        onLapComplete: (event) => {
          callbackOrder.push("complete");
          pendingIssueEligibility = event.eligibility;
          completeEvents.push({
            packetCount: event.packets.length,
            lapDistStart: event.lapDistStart,
            lapTime: event.lapTime,
            isValid: event.isValid,
            eligibility: event.eligibility,
          });
        },
        onLapSaved: (event) => {
          callbackOrder.push("saved");
          savedEvents.push({
            lapNumber: event.lapNumber,
            lapTime: event.lapTime,
            eligibility: event.eligibility,
            issueEligibility: pendingIssueEligibility,
          });
        },
      },
    });

    for (let t = 0; t <= 90; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: 1000 + t * 50, TimestampMS: t * 1000 }));
    }
    await d.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 1000 + 90 * 50 + 30, TimestampMS: 91 * 1000 }));

    expect(callbackOrder).toEqual(["complete", "saved"]);
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].packetCount).toBeGreaterThan(0);
    expect(completeEvents[0].lapDistStart).toBe(1000);
    expect(completeEvents[0].lapTime).toBeCloseTo(90, 0);
    expect(savedEvents).toHaveLength(1);
    expect(savedEvents[0].lapNumber).toBe(1);
    expect(savedEvents[0].lapTime).toBe(completeEvents[0].lapTime);
    expect(savedEvents[0].eligibility).toBe(completeEvents[0].eligibility);
    expect(savedEvents[0].issueEligibility).toBe(completeEvents[0].eligibility);
    expect(savedEvents[0].issueEligibility?.["normal-pace"].status).toBe(savedEvents[0].eligibility["normal-pace"].status);
  });

  test("does not fire onLapComplete for silent incomplete-flush events", async () => {
    const db = makeFakeDb();
    let completeCount = 0;
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      callbacks: {
        onLapComplete: () => {
          completeCount += 1;
        },
      },
    });

    // Drive a partial in-progress lap, then flush
    for (let t = 0; t <= 30; t += 1) {
      await d.feed(packet({ CurrentLap: t, DistanceTraveled: t * 50, TimestampMS: t * 1000 }));
    }
    await d.flushIncompleteLap();

    expect(completeCount).toBe(0);
  });

  test("saves partial initial lap as invalid outlap when recording starts in pit mid-lap", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: timelineWithPitPhases({ 1: "out" }),
    });

    // Recording starts with the car in the pit lane, ~50s into some pre-recording lap
    for (let t = 50; t <= 70; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "pit_lane" } as any,
        }),
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
        }),
      );
    }
    // First reset (end of that pre-recording lap) — on track now
    await d.feed(
      packet({
        CurrentLap: 0.3,
        DistanceTraveled: 90 * 50 + 30,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "out" } as any,
      }),
    );

    // Full clean lap on track
    for (let t = 1; t <= 85; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: 90 * 50 + 30 + t * 50,
          TimestampMS: (91 + t) * 1000,
          acc: { pitStatus: "out" } as any,
        }),
      );
    }
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 999999,
        TimestampMS: 999999,
        acc: { pitStatus: "out" } as any,
      }),
    );

    // Two structurally valid laps: classified out lap, then normal pace lap.
    expect(db.inserted.length).toBe(2);
    expect(db.inserted[0].lapNumber).toBe(1);
    expect(db.inserted[0].valid).toBe(true);
    expect(db.inserted[0]).toMatchObject({ phase: "out", conditions: [], paceEligibility: "excluded" });
    expect(db.inserted[0].invalidReason).toBeNull();
    expect(db.inserted[1].lapNumber).toBe(2);
    expect(db.inserted[1].valid).toBe(true);
    expect(db.inserted[1].lapTime).toBeCloseTo(85, 0);
  });

  test("session restart (distance reset) discards in-progress lap and keeps new packet", async () => {
    const db = makeFakeDb();
    const saved: Array<{ lapNumber: number; lapTime: number }> = [];
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      callbacks: {
        onLapSaved: (event) => {
          saved.push({ lapNumber: event.lapNumber, lapTime: event.lapTime });
        },
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

  test("rejects short-distance lap recordings without changing classification", async () => {
    const db = makeFakeDb();
    const saved: Array<{
      isValid: boolean;
      quality: LapQualitySummary;
    }> = [];
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      callbacks: {
        onLapSaved: (event) => {
          saved.push({
            isValid: event.isValid,
            quality: event.quality,
          });
        },
      },
    });

    for (let t = 0; t <= 50; t += 1) {
      await d.feed(packet({ CurrentLap: t * 2, DistanceTraveled: t, TimestampMS: t * 100 }));
    }
    await d.feed(packet({ CurrentLap: 0.1, DistanceTraveled: 52, TimestampMS: 51000 }));

    expect(saved).toHaveLength(1);
    expect(saved[0].isValid).toBe(false);
    expect(saved[0].quality.facts.map(({ code }) => code)).toContain("partial_track_coverage");
    expect(db.inserted[0]).toMatchObject({
      valid: false,
      invalidReason: "telemetry distance too short",
      phase: "flying",
      conditions: [],
      paceEligibility: "eligible",
    });
  });

  test("classifies ACC lap as out_lap without invalidating telemetry", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: timelineWithPitPhases({ 1: "out" }),
    });

    // Out-lap: starts in pit lane, exits to track, drives a full clean lap
    // First packet: CurrentLap=0, pitStatus=pit_lane (car in pit exit)
    await d.feed(
      packet({
        CurrentLap: 0,
        DistanceTraveled: 0,
        TimestampMS: 0,
        acc: { pitStatus: "pit_lane" } as any,
      }),
    );
    // Next 40 packets: still in pit lane, creeping towards track
    for (let t = 1; t <= 40; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "pit_lane" } as any,
        }),
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
        }),
      );
    }
    // Lap boundary — reset
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 91 * 50,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "out" } as any,
      }),
    );

    expect(db.inserted.length).toBe(1);
    expect(db.inserted[0].valid).toBe(true);
    expect(db.inserted[0]).toMatchObject({ phase: "out", conditions: [], paceEligibility: "excluded" });
    expect(db.inserted[0].invalidReason).toBeNull();
  });

  test("classifies ACC lap as in_lap without invalidating telemetry", async () => {
    const db = makeFakeDb();
    const d = new LapDetectorAcc({
      db,
      lapTimelineContext: timelineWithPitPhases({ 1: "in" }),
    });

    // In-lap: drives most of the lap on track, enters pit lane near the finish
    for (let t = 0; t <= 60; t += 1) {
      await d.feed(
        packet({
          CurrentLap: t,
          DistanceTraveled: t * 50,
          TimestampMS: t * 1000,
          acc: { pitStatus: "out" } as any,
        }),
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
        }),
      );
    }
    // Lap boundary — reset, still in pit
    await d.feed(
      packet({
        CurrentLap: 0.2,
        DistanceTraveled: 91 * 50,
        TimestampMS: 91 * 1000,
        acc: { pitStatus: "pit_lane" } as any,
      }),
    );

    expect(db.inserted.length).toBe(1);
    expect(db.inserted[0].valid).toBe(true);
    expect(db.inserted[0]).toMatchObject({ phase: "in", conditions: [], paceEligibility: "excluded" });
    expect(db.inserted[0].invalidReason).toBeNull();
  });

  test("keeps native-live and replay boundaries and normalized quality semantics in parity", async () => {
    async function detect(sourceKind: "native-live" | "raceiq-raw") {
      const db = makeFakeDb();
      const detector = new LapDetectorAcc({
        db,
        sourceKind,
        lapTimelineContext: EMPTY_LAP_TIMELINE_CONTEXT,
      });
      for (let tick = 0; tick <= 90; tick += 1) {
        if (tick === 45) continue;
        await detector.feed(packet({ CurrentLap: tick, DistanceTraveled: tick * 50, TimestampMS: tick * 1_000 }), tick * 100);
      }
      await detector.feed(packet({ CurrentLap: 0.3, DistanceTraveled: 4_530, TimestampMS: 91_000 }), 9_100);
      return db.inserted[0]!;
    }

    function normalizedFacts(quality: LapQualitySummary) {
      return quality.facts
        .filter(({ code }) => code !== "imported_source")
        .map(({ id: _id, eventIds: _eventIds, provenance, semanticIds, channelFamilies, ...fact }) => ({
          ...fact,
          semanticIds: [...semanticIds].sort(),
          channelFamilies: [...channelFamilies].sort(),
          provenance: {
            schemaVersion: provenance.schemaVersion,
            policyVersion: provenance.policyVersion,
            configurationVersion: provenance.configurationVersion,
          },
        }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }

    function normalizedChannels(quality: LapQualitySummary) {
      return quality.channelQuality.map(({ provenance: _provenance, ...channel }) => channel);
    }

    function normalizedEligibility(eligibility: EligibilityDecisionSet) {
      return Object.fromEntries(
        Object.entries(eligibility).map(([policyId, decision]) => [
          policyId,
          {
            status: decision.status,
            policyId: decision.policyId,
            policyVersion: decision.policyVersion,
            confidence: decision.confidence,
            reasons: decision.reasons
              .filter(({ code }) => code !== "imported_source")
              .map(({ evidenceIds: _evidenceIds, semanticIds, ...reason }) => ({
                ...reason,
                semanticIds: [...semanticIds].sort(),
              }))
              .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
          },
        ]),
      );
    }

    const live = await detect("native-live");
    const replay = await detect("raceiq-raw");
    expect(replay).toMatchObject({
      lapNumber: live.lapNumber,
      lapTime: live.lapTime,
      valid: live.valid,
      invalidReason: live.invalidReason,
      phase: live.phase,
      conditions: live.conditions,
      paceEligibility: live.paceEligibility,
      rawByteOffset: live.rawByteOffset,
      rawFrameCount: live.rawFrameCount,
    });
    expect(replay.quality.participant).toEqual(live.quality.participant);
    expect(replay.quality.classification).toEqual(live.quality.classification);
    expect(replay.quality.gapSummary).toEqual(live.quality.gapSummary);
    expect(replay.quality.timing).toEqual(live.quality.timing);
    expect(replay.quality.trackDistanceCoverage).toBe(live.quality.trackDistanceCoverage);
    expect(replay.quality.worldPositionCoverage).toBe(live.quality.worldPositionCoverage);
    expect(normalizedChannels(replay.quality)).toEqual(normalizedChannels(live.quality));
    expect(normalizedFacts(replay.quality)).toEqual(normalizedFacts(live.quality));
    expect(normalizedEligibility(replay.eligibility)).toEqual(normalizedEligibility(live.eligibility));
  });
});

test(
  "parseDump runs against the problem recording without throwing",
  async () => {
    const result = await parseDump("acc", "test/artifacts/sessions/acc-2026-04-10T02-59-28-972Z.bin.gz");
    expect(result.laps.length).toBeGreaterThan(0);
  },
  { timeout: 30000 },
);

test(
  "session bin: laps 1+2 have no isValidLap=false, laps 3+4 contain isValidLap=false frames",
  async () => {
    const result = await parseDump("acc", "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz");
    const byLap = new Map(result.laps.map((l) => [l.lapNumber, l]));
    expect(byLap.get(1)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(false);
    expect(byLap.get(2)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(false);
    expect(byLap.get(3)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(true);
    expect(byLap.get(4)?.packets?.some((p) => p.acc?.isValidLap === false)).toBe(true);
  },
  { timeout: 60000 },
);
