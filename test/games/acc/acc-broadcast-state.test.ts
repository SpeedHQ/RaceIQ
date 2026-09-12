import { expect, test } from "bun:test";
import { AccBroadcastState } from "../../../server/games/acc/broadcast-state";

test("joins ACC entry identity with aligned class, phase, and connectivity arrays", () => {
  let now = 1_000;
  const state = new AccBroadcastState({ now: () => now, competitorStaleMs: 1_000 });
  state.apply({ type: "realtime-update", eventIndex: 3, sessionIndex: 2, sessionType: 10, phase: 5, sessionTimeMs: 1000, sessionEndTimeMs: 0, focusedCarIndex: 7, activeCameraSet: "", activeCamera: "", currentHudPage: "", replayPlaying: false, bestSessionLap: { timeMs: null, carIndex: 0, driverIndex: 0, splitsMs: [], isInvalid: true, isValidForBest: false, isOutlap: false, isInlap: false } });
  state.apply({ type: "entry-list-car", carIndex: 7, carModelType: 1, teamName: "Team", raceNumber: 12, cupCategory: 3, currentDriverIndex: 0, nationality: 1, drivers: [{ firstName: "A", lastName: "Driver", shortName: "ADR", category: 3, nationality: 1 }] });
  state.apply({ type: "realtime-car-update", carIndex: 7, driverIndex: 0, driverCount: 1, gear: 3, worldPosX: 10, worldPosY: 0, yaw: 0.5, location: 1, kmh: 180, position: 1, cupPosition: 1, splinePosition: 0.5, laps: 4, deltaMs: 0, bestLapTimeMs: 90_000, lastLapTimeMs: 91_000, lastLapValid: true, currentLapTimeMs: 12_000 });
  expect(state.snapshot()).toMatchObject({ playerCarIndex: 7, playerCarClassId: "3", phase: 5, sessionType: "race", carIndex: [7], carClassId: ["3"], connected: [true] });
  now = 2_001;
  expect(state.snapshot()?.connected).toEqual([false]);
});

test("resets joined cars when ACC session changes", () => {
  const state = new AccBroadcastState();
  state.apply({ type: "realtime-update", eventIndex: 1, sessionIndex: 1, sessionType: 1, phase: 1, sessionTimeMs: 0, sessionEndTimeMs: 0, focusedCarIndex: 2, activeCameraSet: "", activeCamera: "", currentHudPage: "", replayPlaying: false, bestSessionLap: { timeMs: null, carIndex: 0, driverIndex: 0, splitsMs: [], isInvalid: true, isValidForBest: false, isOutlap: false, isInlap: false } });
  state.apply({ type: "entry-list-car", carIndex: 2, carModelType: 1, teamName: "Team", raceNumber: 2, cupCategory: 0, currentDriverIndex: 0, nationality: 1, drivers: [{ firstName: "A", lastName: "Driver", shortName: "ADR", category: 3, nationality: 1 }] });
  state.apply({ type: "realtime-car-update", carIndex: 2, driverIndex: 0, driverCount: 1, gear: 3, worldPosX: 10, worldPosY: 0, yaw: 0.5, location: 1, kmh: 180, position: 1, cupPosition: 1, splinePosition: 0.5, laps: 4, deltaMs: 0, bestLapTimeMs: 90_000, lastLapTimeMs: 91_000, lastLapValid: true, currentLapTimeMs: 12_000 });
  expect(state.snapshot()?.carIndex).toEqual([2]);
  state.apply({ type: "realtime-update", eventIndex: 2, sessionIndex: 2, sessionType: 2, phase: 1, sessionTimeMs: 0, sessionEndTimeMs: 0, focusedCarIndex: 9, activeCameraSet: "", activeCamera: "", currentHudPage: "", replayPlaying: false, bestSessionLap: { timeMs: null, carIndex: 0, driverIndex: 0, splitsMs: [], isInvalid: true, isValidForBest: false, isOutlap: false, isInlap: false } });
  expect(state.snapshot()).toBeUndefined();
});
