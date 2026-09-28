import { expect, test } from "bun:test";
import { AccBroadcastState, attachAccBroadcastSnapshot } from "../../../server/games/acc/broadcast-state";
import type { AccBroadcastMessage } from "../../../shared/telemetry/acc-broadcast";
import type { TelemetryPacket } from "../../../shared/telemetry/types";

const session = (sessionIndex = 2, focusedCarIndex = 7): AccBroadcastMessage => ({
  type: "realtime-update", eventIndex: 3, sessionIndex, sessionType: 10, phase: 5,
  sessionTimeMs: 1000, sessionEndTimeMs: 0, focusedCarIndex,
  activeCameraSet: "", activeCamera: "", currentHudPage: "", replayPlaying: false,
  bestSessionLap: { timeMs: null, carIndex: 0, driverIndex: 0, splitsMs: [], isInvalid: true, isValidForBest: false, isOutlap: false, isInlap: false },
});
const entry = (carIndex = 7, currentDriverIndex = 0): AccBroadcastMessage => ({
  type: "entry-list-car", carIndex, carModelType: 1, teamName: "Team", raceNumber: 12,
  cupCategory: 3, currentDriverIndex, nationality: 1,
  drivers: [{ firstName: "A", lastName: "Driver", shortName: "ADR", category: 3, nationality: 1 }],
});
const car = (carIndex = 7, driverIndex = 0): Extract<AccBroadcastMessage, { type: "realtime-car-update" }> => ({
  type: "realtime-car-update", carIndex, driverIndex, driverCount: 1, gear: 3,
  worldPosX: 10, worldPosY: 0, yaw: 0.5, location: 1, kmh: 180, position: 1,
  cupPosition: 1, splinePosition: 0.5, laps: 4, deltaMs: 0, bestLapTimeMs: 90_000,
  lastLapTimeMs: 91_000, lastLapValid: true, currentLapTimeMs: 12_000,
});
function register(state: AccBroadcastState): void {
  state.setSocketConnected(true);
  state.apply({ type: "registration-result", connectionId: 1, success: true, readOnly: true, error: "" });
}
function populate(state: AccBroadcastState): void {
  state.apply(session());
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
  state.apply(entry());
  state.apply(car());
}

test("joins identity and realtime in either arrival order and exposes only nested aligned snapshot", () => {
  for (const realtimeFirst of [false, true]) {
    const state = new AccBroadcastState();
    register(state);
    state.apply(realtimeFirst ? car() : entry());
    state.apply(session());
    state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
    expect(state.snapshot().extension).toBeUndefined();
    state.apply(realtimeFirst ? entry() : car());
    expect(state.snapshot()).toMatchObject({ source: { state: "available", reasonCode: "ready" }, extension: {
      playerCarIndex: 7, playerCarClassId: "3", phase: 5, sessionType: "race", carIndex: [7], carClassId: ["3"], connected: [true],
    } });
  }
});

test("realtime cannot invent socket or registration evidence", () => {
  const state = new AccBroadcastState();
  populate(state);
  expect(state.snapshot().source.reasonCode).toBe("not-connected");
  state.setSocketConnected(true);
  populate(state);
  expect(state.snapshot().source.reasonCode).toBe("not-registered");
  state.apply({ type: "registration-result", connectionId: 1, success: false, readOnly: true, error: "denied" });
  state.apply(session());
  expect(state.snapshot().source.reasonCode).toBe("not-registered");
});

test("requires every listed member and prunes identities and realtime on removal", () => {
  const state = new AccBroadcastState();
  register(state);
  populate(state);
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [9, 7] });
  expect(state.snapshot().extension).toBeUndefined();
  state.apply(entry(9));
  expect(state.snapshot().extension).toBeUndefined();
  state.apply(car(9));
  expect(state.snapshot().extension?.carIndex).toEqual([7, 9]);
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
  state.apply(car(9)); // Late datagram from removed competitor cannot revive it.
  expect(state.hasEntry(9)).toBe(false);
  expect(state.snapshot().extension?.carIndex).toEqual([7]);
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7, 9] });
  state.apply(entry(9));
  expect(state.snapshot().extension).toBeUndefined();
  state.apply(car(9));
  expect(state.snapshot().extension?.carIndex).toEqual([7, 9]);
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [] });
  expect(state.snapshot().source).toEqual({ state: "unavailable", reasonCode: "incomplete-grid" });
});

test("session reset with reused car index and negative focus cannot reuse identity", () => {
  const state = new AccBroadcastState();
  register(state);
  populate(state);
  state.apply(session(3, -1));
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
  state.apply(car());
  expect(state.hasEntry(7)).toBe(false);
  expect(state.snapshot().extension).toBeUndefined();
  state.apply(entry());
  expect(state.snapshot().extension).toBeUndefined();
  state.setPlayerCarIndex(7);
  expect(state.snapshot().extension?.carIndex).toEqual([7]);
  state.setPlayerCarIndex(-1);
  expect(state.snapshot().extension).toBeUndefined();
});

test("socket loss and explicit reset require new registration and complete evidence", () => {
  const state = new AccBroadcastState();
  register(state);
  populate(state);
  state.setSocketConnected(false);
  expect(state.snapshot()).toEqual({ source: { state: "unavailable", reasonCode: "not-connected" } });
  state.setSocketConnected(true);
  state.apply(session());
  expect(state.snapshot().source.reasonCode).toBe("not-registered");
  register(state);
  expect(state.hasEntry(7)).toBe(false);
  populate(state);
  expect(state.snapshot().extension?.carIndex).toEqual([7]);
  state.reset();
  populate(state);
  expect(state.snapshot().source.reasonCode).toBe("not-connected");
});

test("malformed source recovers only with fresh complete session, membership, identity and realtime", () => {
  let now = 0;
  const state = new AccBroadcastState({ now: () => now });
  register(state);
  populate(state);
  state.markMalformed();
  state.apply(car());
  state.apply(entry());
  expect(state.snapshot().source.state).toBe("malformed");
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
  state.setPlayerCarIndex(7);
  expect(state.snapshot().source.state).toBe("malformed");
  now = 1_001;
  state.apply(session());
  expect(state.snapshot().source.state).toBe("malformed");
  state.apply(car());
  expect(state.snapshot().source.state).toBe("available");
});

test("whole source staleness removes arrays while per-car timeout marks disconnected", () => {
  let now = 1_000;
  const state = new AccBroadcastState({ now: () => now });
  register(state);
  populate(state);
  now = 2_001;
  expect(state.snapshot()).toEqual({ source: { state: "stale", reasonCode: "source-timeout" } });
  state.apply(session());
  expect(state.snapshot().extension?.connected).toEqual([false]);
  state.apply(car());
  expect(state.snapshot().extension?.connected).toEqual([true]);
});

test("rejects duplicate and oversized entry lists", () => {
  const state = new AccBroadcastState();
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: [1, 1] });
  expect(state.snapshot().source).toEqual({ state: "malformed", reasonCode: "duplicate-car-index" });
  state.reset();
  state.apply({ type: "entry-list", connectionId: 1, carIndexes: Array.from({ length: 65 }, (_, index) => index) });
  expect(state.snapshot().source).toEqual({ state: "malformed", reasonCode: "too-many-competitors" });
});

test("invalid driver indexes fail closed regardless identity arrival order", () => {
  for (const messages of [[entry(7, -1)], [car(7, 1)], [entry(7, 1)], [car(), entry(7, 1)]]) {
    const state = new AccBroadcastState();
    register(state);
    populate(state);
    for (const message of messages) state.apply(message);
    expect(state.snapshot()).toEqual({ source: { state: "malformed", reasonCode: "invalid-driver-index" } });
  }
});

test("valid realtime driver count cannot bypass joined entry driver bounds", () => {
  const realtime = { ...car(7, 1), driverCount: 2 };
  for (const messages of [[realtime, entry()], [entry(), realtime]]) {
    const state = new AccBroadcastState();
    register(state);
    state.apply(session());
    state.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
    for (const message of messages) state.apply(message);
    expect(state.snapshot()).toEqual({ source: { state: "malformed", reasonCode: "invalid-driver-index" } });
  }
});

test("attachment replaces source status and clears old arrays without touching player telemetry", () => {
  const state = new AccBroadcastState();
  register(state);
  populate(state);
  const packet = { acc: {}, TimestampMS: 123, Speed: 45 } as unknown as TelemetryPacket;
  attachAccBroadcastSnapshot(packet, 7, state.snapshot());
  expect(packet.acc?.broadcastCarIndex).toEqual([7]);
  state.markMalformed("capture-overflow");
  attachAccBroadcastSnapshot(packet, 7, state.snapshot());
  expect(packet.acc?.broadcastSource).toEqual({ source: "acc-broadcast", state: "malformed", reasonCode: "capture-overflow" });
  expect(packet.acc?.broadcastCarIndex).toBeUndefined();
  expect(packet.acc?.broadcastPlayerCarIndex).toBeUndefined();
  expect(packet.TimestampMS).toBe(123);
  expect(packet.Speed).toBe(45);
});
