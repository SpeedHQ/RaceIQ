import { describe, expect, spyOn, test } from "bun:test";
import { LapDetector, type LapCompleteEvent } from "../../server/lap-detection/detector";
import { CapturingDbAdapter } from "../../server/telemetry/pipeline-ports";
import { initServerGameAdapters } from "../../server/games/init";
import type { GameId } from "../../shared/games/ids";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import * as CurbRecording from "../../shared/racing/tracks/recording/curbs";
import * as OutlineRecording from "../../shared/racing/tracks/recording/outlines";

initGameAdapters();
initServerGameAdapters();

const UNKNOWN_TRACK_ORDINAL = 999_731;

type LapScenario = {
  gameId: GameId;
  lapNumber: number;
  iracing?: TelemetryPacket["iracing"];
  distanceStep?: number;
  f1?: TelemetryPacket["f1"];
};

function packet(scenario: LapScenario, index: number, overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId: scenario.gameId,
    IsRaceOn: 1,
    TimestampMS: index * 100,
    LapNumber: scenario.lapNumber,
    CurrentLap: index * 1.5,
    LastLap: 0,
    BestLap: 0,
    CurrentRaceTime: index * 1.5,
    DistanceTraveled: 100 + index * (scenario.distanceStep ?? 100),
    CarOrdinal: 42,
    TrackOrdinal: UNKNOWN_TRACK_ORDINAL,
    CarPerformanceIndex: 0,
    CarClass: 0,
    RacePosition: 1,
    PositionX: 100 + index,
    PositionY: 0,
    PositionZ: 200 + index * 2,
    Speed: 60,
    Yaw: index / 60,
    Fuel: 50 - index * 0.01,
    TireWearFL: 1,
    TireWearFR: 1,
    TireWearRL: 1,
    TireWearRR: 1,
    WheelOnRumbleStripFL: 1,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    iracing: scenario.iracing,
    f1: scenario.f1,
    ...overrides,
  } as TelemetryPacket;
}

async function completeLap(scenario: LapScenario) {
  const db = new CapturingDbAdapter();
  const completed: LapCompleteEvent[] = [];
  const detector = new LapDetector({
    db,
    bypassPacketRateFilter: true,
    callbacks: {
      onLapComplete: (event) => completed.push(event),
    },
  });

  for (let index = 0; index <= 60; index += 1) {
    await detector.feed(packet(scenario, index));
  }
  await detector.feed(
    packet(scenario, 61, {
      LapNumber: scenario.lapNumber + 1,
      CurrentLap: 0.1,
      LastLap: 90,
    }),
  );

  return { completed, db, detector };
}

function recordingSpies() {
  return {
    curb: spyOn(CurbRecording, "recordCurbData").mockImplementation(() => {}),
    outline: spyOn(OutlineRecording, "recordLapTrace").mockImplementation(() => {}),
  };
}

describe("LapDetector normal-pace geometry recording gates", () => {
  test("persists a structurally valid iRacing pit lap without normal-pace callbacks or geometry", async () => {
    const spies = recordingSpies();
    try {
      const result = await completeLap({
        gameId: "iracing",
        lapNumber: 2,
        iracing: { onPitRoad: true, incidents: 0 } as TelemetryPacket["iracing"],
      });

      expect(result.db.laps).toHaveLength(1);
      expect(result.db.laps[0]).toMatchObject({
        isValid: true,
        phase: "pit",
        paceEligibility: "excluded",
      });
      expect(result.completed).toHaveLength(0);
      expect(result.detector.session?.bestLapTime).toBe(0);
      expect(spies.outline).not.toHaveBeenCalled();
      expect(spies.curb).not.toHaveBeenCalled();
    } finally {
      spies.outline.mockRestore();
      spies.curb.mockRestore();
    }
  });

  test("does not seed curb geometry from a structurally valid F1 grid-start lap", async () => {
    const spies = recordingSpies();
    try {
      const result = await completeLap({
        gameId: "f1-2025",
        lapNumber: 1,
        f1: { gridPosition: 1, safetyCarStatus: 0 } as TelemetryPacket["f1"],
      });

      expect(result.db.laps).toHaveLength(1);
      expect(result.db.laps[0]).toMatchObject({
        isValid: true,
        phase: "grid_start",
        paceEligibility: "excluded",
      });
      expect(result.completed).toHaveLength(0);
      expect(result.detector.session?.bestLapTime).toBe(0);
      expect(spies.curb).not.toHaveBeenCalled();
    } finally {
      spies.outline.mockRestore();
      spies.curb.mockRestore();
    }
  });

  test("does not seed curb geometry from a structurally valid caution lap", async () => {
    const spies = recordingSpies();
    try {
      const result = await completeLap({
        gameId: "f1-2025",
        lapNumber: 2,
        f1: { gridPosition: 0, safetyCarStatus: 1 } as TelemetryPacket["f1"],
      });

      expect(result.db.laps).toHaveLength(1);
      expect(result.db.laps[0]).toMatchObject({
        isValid: true,
        phase: "flying",
        conditions: ["caution"],
        paceEligibility: "excluded",
      });
      expect(result.completed).toHaveLength(0);
      expect(result.detector.session?.bestLapTime).toBe(0);
      expect(spies.curb).not.toHaveBeenCalled();
    } finally {
      spies.outline.mockRestore();
      spies.curb.mockRestore();
    }
  });

  test("keeps classification but rejects structurally invalid lap recordings", async () => {
    const spies = recordingSpies();
    try {
      const result = await completeLap({
        gameId: "iracing",
        lapNumber: 2,
        distanceStep: 1,
        iracing: { onPitRoad: false, incidents: 0 } as TelemetryPacket["iracing"],
      });

      expect(result.db.laps).toHaveLength(1);
      expect(result.db.laps[0]).toMatchObject({
        isValid: false,
        invalidReason: "telemetry distance too short",
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
      });
      expect(result.completed).toHaveLength(0);
      expect(result.detector.session?.bestLapTime).toBe(0);
      expect(spies.outline).not.toHaveBeenCalled();
      expect(spies.curb).not.toHaveBeenCalled();
    } finally {
      spies.outline.mockRestore();
      spies.curb.mockRestore();
    }
  });
  test("uses one eligible flying-lap decision for best lap, iRacing outline, and curb recording", async () => {
    const spies = recordingSpies();
    try {
      const result = await completeLap({
        gameId: "iracing",
        lapNumber: 2,
        iracing: { onPitRoad: false, incidents: 0 } as TelemetryPacket["iracing"],
      });

      expect(result.db.laps).toHaveLength(1);
      expect(result.db.laps[0]).toMatchObject({
        isValid: true,
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
      });
      expect(result.completed).toHaveLength(1);
      expect(result.completed[0].eligibility["normal-pace"].status).toMatch(/^eligible/);
      expect(result.detector.session?.bestLapTime).toBe(90);
      expect(spies.outline).toHaveBeenCalledTimes(1);
      expect(spies.curb).toHaveBeenCalledTimes(1);
    } finally {
      spies.outline.mockRestore();
      spies.curb.mockRestore();
    }
  });
});
