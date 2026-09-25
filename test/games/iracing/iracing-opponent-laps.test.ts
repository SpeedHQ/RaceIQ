import { expect, test } from "bun:test";
import { normalizeIRacingFrame, createIRacingParserState } from "../../../server/games/iracing/normalizer";
import { parseIRacingDrivers, parseIRacingSessionType } from "../../../server/games/iracing/session-info";
import { sampleFrameV3 } from "../../support/games/iracing-sdk";
import { LiveTelemetryProjector } from "../../../server/telemetry/live-projector";
import { extractLiveEngineerSemanticInput } from "../../../server/live-strategy/live-engineer-semantic-input";
import { LiveEngineerVoiceEngine } from "../../../server/live-strategy/live-engineer-voice-engine";
import type { LiveEngineerCalloutMessageV3, LiveEngineerVoiceLineMessageV3 } from "../../../shared/racing/live/engineer-contracts";

test("parses and aligns source-backed iRacing competitor snapshots", () => {
  const yaml = `DriverInfo:\n  Drivers:\n  - CarIdx: 0\n    UserID: 11\n    UserName: Player\n    CarClassID: 1\n    CarClassShortName: GT3\n    IsSpectator: 0\n    CarIsPaceCar: 0\n  - CarIdx: 7\n    UserID: 22\n    AbbrevName: Opponent\n    CarClassID: 1\n    CarClassShortName: GT3\n    IsSpectator: 0\n    CarIsPaceCar: 0\n`;
  expect(parseIRacingDrivers(yaml)).toEqual([
    { carIndex: 0, userId: 11, displayName: "Player", carClassId: 1, carClassShortName: "GT3", isSpectator: false, carIsPaceCar: false },
    { carIndex: 7, userId: 22, displayName: "Opponent", carClassId: 1, carClassShortName: "GT3", isSpectator: false, carIsPaceCar: false },
  ]);
  const frame = sampleFrameV3(yaml);
  frame.values.CarIdxPosition = [1, 0, 0, 0, 0, 0, 0, 2];
  frame.values.CarIdxClassPosition = [1, 0, 0, 0, 0, 0, 0, 2];
  frame.values.CarIdxLapCompleted = [4, 0, 0, 0, 0, 0, 0, 4];
  frame.values.CarIdxOnPitRoad = [false, false, false, false, false, false, false, false];
  frame.values.CarIdxLastLapTime = [90, 0, 0, 0, 0, 0, 0, 88];
  frame.values.CarIdxBestLapTime = [90, 0, 0, 0, 0, 0, 0, 88];
  frame.values.CarIdxTrackSurface = [3, 0, 0, 0, 0, 0, 0, 2];
  const packet = normalizeIRacingFrame(frame, createIRacingParserState());
  expect(packet.iracing?.competitors).toEqual([
    expect.objectContaining({ carIndex: 0, driverId: "11", driverName: "Player", carClassIdString: "1", carClassName: "GT3", pitStatus: "out", trackLocationName: "track", position: 1, lapsComplete: 4, lastLapTime: 90, trackLocation: 3 }),
    expect.objectContaining({ carIndex: 7, driverId: "22", driverName: "Opponent", carClassIdString: "1", carClassName: "GT3", pitStatus: "out", trackLocationName: "approaching-pits", position: 2, lapsComplete: 4, lastLapTime: 88, trackLocation: 2 }),
  ]);
});

test("selects matching iRacing session type by session number", () => {
  const yaml = "SessionInfo:\n  Sessions:\n  - SessionNum: 0\n    SessionType: Practice\n  - SessionNum: 2\n    SessionType: Lone Qualify\n";
  expect(parseIRacingSessionType(yaml, 2)).toBe("lone_qualify");
  expect(parseIRacingSessionType(yaml, 9)).toBe("unknown");
});

function sparsePaceFrame(lap: number) {
  const source = sampleFrameV3("DriverInfo:\n  Drivers:\n  - CarIdx: 0\n    UserID: 11\n    UserName: Player\n    CarClassID: 1\n    CarClassShortName: GT3\n  - CarIdx: 7\n    UserID: 22\n    UserName: Opponent\n    CarClassID: 1\n    CarClassShortName: GT3\nSessionInfo:\n  Sessions:\n  - SessionNum: 2\n    SessionType: Practice\n");
  source.session.driverCarIdx = 0;
  source.session.carClassId = 1;
  Object.assign(source.values, {
    Lap: lap, LapLastLapTime: 90, SessionTime: lap,
    CarIdxPosition: [1, 0, 0, 0, 0, 0, 0, 2],
    CarIdxClassPosition: [1, 0, 0, 0, 0, 0, 0, 2],
    CarIdxLapCompleted: [lap - 1, 0, 0, 0, 0, 0, 0, 4],
    CarIdxOnPitRoad: [false, false, false, false, false, false, false, false],
    CarIdxLastLapTime: [90, 0, 0, 0, 0, 0, 0, 88],
    CarIdxBestLapTime: [90, 0, 0, 0, 0, 0, 0, 88],
    CarIdxTrackSurface: [3, -1, -1, -1, -1, -1, -1, 3],
  });
  return source;
}

test("sparse iRacing source rows reach projected pace and voice without raw-array padding", () => {
  const projector = new LiveTelemetryProjector();
  const emitted: (LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3)[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
  const state = createIRacingParserState();
  for (const lap of [1, 2]) {
    const packet = normalizeIRacingFrame(sparsePaceFrame(lap), state);
    const { semanticFrame } = projector.project({ packet, sessionId: 1, receivedAtMs: lap * 1000 });
    const input = extractLiveEngineerSemanticInput(semanticFrame);
    expect(input.pace).toMatchObject({
      playerCarIndex: 0, playerCarClassId: "1",
      competitorCarIndexes: [0, 7], competitorDriverIds: ["11", "22"],
      competitorDriverNames: ["Player", "Opponent"], competitorClassIds: ["1", "1"],
      competitorClassNames: ["GT3", "GT3"], competitorLaps: [lap - 1, 4],
      competitorLastLapTimes: [90, 88], competitorPitStatuses: ["out", "out"],
      competitorTrackLocations: ["track", "track"],
    });
    engine.consume(semanticFrame);
  }
  expect(emitted).toContainEqual(expect.objectContaining({
    type: "live-engineer-callout", family: "opponent-pace",
    render: expect.objectContaining({ parameters: expect.objectContaining({ benchmarkLapTimeMs: 88_000, deltaMs: 2_000, scope: "class" }) }),
  }));
});

test("absent, stale, and misaligned iRacing pace evidence stays silent through projection", () => {
  for (const failure of ["missing", "stale", "misaligned", "duplicate"] as const) {
    const projector = new LiveTelemetryProjector();
    const emitted: unknown[] = [];
    const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
    for (const lap of [1, 2]) {
      const source = sparsePaceFrame(lap);
      if (failure === "missing") delete source.values.CarIdxLastLapTime;
      const packet = normalizeIRacingFrame(source);
      if (failure === "misaligned") packet.iracing!.competitorLastLapTime = [90];
      if (failure === "duplicate") packet.iracing!.competitorCarIndex = [0, 0];
      const { semanticFrame } = projector.project({ packet, sessionId: 1, receivedAtMs: lap * 1000 });
      const frame = failure === "stale" ? {
        ...semanticFrame,
        values: semanticFrame.values.map((value) => value.semanticId === "race.competitor.laps-complete" ? { ...value, freshness: "stale" as const } : value),
      } : semanticFrame;
      expect(extractLiveEngineerSemanticInput(frame).pace).toBeNull();
      engine.consume(frame);
    }
    expect(emitted).toEqual([]);
  }
});

test("iRacing joined rows never fabricate missing driver identity or location", () => {
  const source = sparsePaceFrame(1);
  source.sessionInfo = source.sessionInfo.replace("    UserName: Opponent\n", "");
  expect(normalizeIRacingFrame(source).iracing?.competitors?.map((row) => row.carIndex)).toEqual([0]);
  const invalidLocation = sparsePaceFrame(1);
  invalidLocation.values.CarIdxTrackSurface = [3, -1, -1, -1, -1, -1, -1, 99];
  expect(normalizeIRacingFrame(invalidLocation).iracing?.competitors?.map((row) => row.carIndex)).toEqual([0]);
});
