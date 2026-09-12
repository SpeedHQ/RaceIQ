import { expect, test } from "bun:test";
import { normalizeIRacingFrame, createIRacingParserState } from "../../../server/games/iracing/normalizer";
import { parseIRacingDrivers, parseIRacingSessionType } from "../../../server/games/iracing/session-info";
import { sampleFrameV3 } from "../../support/games/iracing-sdk";

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
    expect.objectContaining({ carIndex: 7, driverId: "22", driverName: "Opponent", carClassIdString: "1", carClassName: "GT3", pitStatus: "out", trackLocationName: "pit-stall", position: 2, lapsComplete: 4, lastLapTime: 88, trackLocation: 2 }),
  ]);
});

test("selects matching iRacing session type by session number", () => {
  const yaml = "SessionInfo:\n  Sessions:\n  - SessionNum: 0\n    SessionType: Practice\n  - SessionNum: 2\n    SessionType: Lone Qualify\n";
  expect(parseIRacingSessionType(yaml, 2)).toBe("lone_qualify");
  expect(parseIRacingSessionType(yaml, 9)).toBe("unknown");
});
