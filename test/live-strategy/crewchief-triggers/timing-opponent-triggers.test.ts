import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";
import { CrewChiefTriggerFrame } from "../../../server/live-strategy/crewchief-triggers/frame";
import { createPreviousValueState, type PreviousValueState } from "../../../server/live-strategy/crewchief-triggers/common";
import type { CrewChiefTriggerFunction } from "../../../server/live-strategy/crewchief-triggers/contracts";
import { triggerDriverSwaps, triggerRatings, triggerTimings, triggerWatchedOpponents } from "../../../server/live-strategy/crewchief-triggers/timing-opponent-triggers";
import { AccBroadcastState } from "../../../server/games/acc/broadcast-state";
import type { AccBroadcastCar } from "../../../shared/telemetry/acc-broadcast";

const resolved = (semanticId: string, current: unknown): ResolvedValue<unknown> => ({
  semanticId,
  value: current,
  unit: null,
  mappingStatus: "direct",
  state: "ok",
  confidence: 1,
  freshness: "fresh",
  confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 },
  provenance: {} as ResolvedValue<unknown>["provenance"],
  schemaVersion: "test",
  limitations: [],
});

const frame = (sequence: number, values: Record<string, unknown>): LiveResolvedSemanticFrame => {
  const entries: readonly [string, unknown][] = [
    ["session.session-state", 5],
    ["race.pit-status", "out"],
    ["race.on-pit-road", false],
    ["identity.player-car-index", 0],
    ["identity.player-car-class-id", "gt3"],
    ["motion.position-x", 0],
    ["motion.position-z", 0],
    ["motion.speed", 50],
    ["race.competitor.car-index", [1]],
    ["race.competitor.connected", [true]],
    ["race.competitor.pit-status", ["out"]],
    ["race.competitor.car-class-id", ["gt3"]],
    ["race.competitor.laps-complete", [1]],
    ["motion.competitor.position-x", [2]],
    ["motion.competitor.position-z", [2]],
    ["motion.competitor.speed", [50]],
    ["timing.lap-number", 2],
    ["timing.last-lap", 91.2],
    ["timing.current-lap-valid", true],
    ...Object.entries(values),
  ];
  return {
    simulator: "acc",
    sessionId: 1,
    streamId: "acc-timing",
    sequence,
    observedAt: { domain: "wall-clock", milliseconds: sequence * 1000 },
    ids: entries.map(([id]) => id),
    values: entries.map(([id, value]) => resolved(id, value)),
  };
};

const events = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame) => catalog.consume(source).events;
const timingValues = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "session.session-type": "race",
  "race.competitor.car-index": [0, 7, 9],
  "race.competitor.driver-id": ["0:0", "7:0", "9:0"],
  "race.competitor.position": [2, 1, 3],
  "race.competitor.pit-status": ["out", "out", "out"],
  "race.competitor.connected": [true, true, true],
  "timing.gap-ahead-ms": 8_000,
  "timing.gap-behind-ms": 4_000,
  ...overrides,
});
const run = (
  trigger: CrewChiefTriggerFunction<PreviousValueState>,
  state: PreviousValueState,
  seconds: number,
  values: Record<string, unknown>,
  simulator: LiveResolvedSemanticFrame["simulator"] = "acc",
) => {
  const source = new CrewChiefTriggerFrame({ ...frame(seconds, values), simulator });
  const result = trigger({ frame: source, context: source.context(), sessionTimeMs: seconds * 1_000 }, state);
  return result === null ? [] : "eventKey" in result ? [result] : result;
};

describe("ACC CrewChief timing and opponent triggers", () => {
  test("emits one LapTimes lap-completed event with lap/time payload only for valid lap edge", () => {
    const catalog = new CrewChiefTriggerCatalog();
    events(catalog, frame(0, {}));
    const emitted = events(catalog, frame(1, { "timing.lap-number": 3, "timing.last-lap": 90.5 }));
    expect(emitted.filter((event) => event.family === "LapTimes")).toEqual([
      expect.objectContaining({ eventKey: "lap-completed", payload: { lap: 2, time: 90.5 } }),
    ]);

    const invalid = new CrewChiefTriggerCatalog();
    events(invalid, frame(0, { "timing.current-lap-valid": false }));
    expect(events(invalid, frame(1, {
      "timing.lap-number": 3,
      "timing.last-lap": 90.5,
      "timing.current-lap-valid": true,
    })).filter((event) => event.family === "LapTimes")).toHaveLength(0);

    const inPit = new CrewChiefTriggerCatalog();
    events(inPit, frame(0, {}));
    expect(events(inPit, frame(1, {
      "timing.lap-number": 3,
      "race.pit-status": "in_pit",
    })).filter((event) => event.family === "LapTimes")).toHaveLength(0);
  });

  test("emits one opponent lap-completed event per competitor increment, not fresh-array churn", () => {
    const catalog = new CrewChiefTriggerCatalog();
    events(catalog, frame(0, { "race.competitor.laps-complete": [1] }));
    const increment = events(catalog, frame(1, { "race.competitor.laps-complete": [2] }));
    expect(increment.filter((event) => event.family === "Opponents")).toEqual([
      expect.objectContaining({ eventKey: "opponent-lap-completed", payload: { competitorIndex: 1, lap: 2 } }),
    ]);
    expect(events(catalog, frame(2, { "race.competitor.laps-complete": [2] })).filter((event) => event.family === "Opponents")).toHaveLength(0);
    expect(events(catalog, frame(3, { "race.competitor.laps-complete": [2] })).filter((event) => event.family === "Opponents")).toHaveLength(0);
  });

  test("latches multiclass traffic for faster different-class competitor inside spatial window", () => {
    const catalog = new CrewChiefTriggerCatalog();
    events(catalog, frame(0, { "race.competitor.car-class-id": ["gt4"] }));
    const emitted = events(catalog, frame(1, {
      "race.competitor.car-class-id": ["gt4"],
      "motion.competitor.position-x": [2],
      "motion.competitor.position-z": [2],
      "motion.competitor.speed": [70],
    }));
    expect(emitted.filter((event) => event.family === "MulticlassWarnings")).toEqual([
      expect.objectContaining({ eventKey: "multiclass-traffic", payload: expect.any(Object) }),
    ]);
    expect(events(catalog, frame(2, {
      "race.competitor.car-class-id": ["gt4"],
      "motion.competitor.speed": [70],
    })).filter((event) => event.family === "MulticlassWarnings")).toHaveLength(0);
  });

  test("keeps unconfigured or source-incomplete families silent", () => {
    const catalog = new CrewChiefTriggerCatalog();
    events(catalog, frame(0, {}));
    const emitted = events(catalog, frame(1, {
      "timing.lap-fraction": 0.5,
      "race.competitor.laps-complete": [3],
      "race.competitor.rating": [99],
      "session.driver-change.drivers-used": ["driver-b"],
    }));
    expect(emitted.filter((event) => ["Timings", "WatchedOpponents", "Ratings", "DriverSwaps"].includes(event.family))).toHaveLength(0);
  });
});

describe("source-backed timing and driver changes", () => {
  test("samples real ACC millisecond gaps, preserves car identity across reorder, and bounds trend announcements", () => {
    const state = createPreviousValueState();
    const consume = (seconds: number, overrides: Record<string, unknown> = {}) =>
      run(triggerTimings, state, seconds, timingValues(overrides));
    expect(consume(0)).toEqual([]);
    expect(consume(1, { "timing.gap-ahead-ms": 6_000 })).toEqual([]);
    expect(consume(10, {
      "race.competitor.car-index": [9, 7, 0],
      "race.competitor.driver-id": ["9:0", "7:0", "0:0"],
      "race.competitor.position": [3, 1, 2],
      "timing.gap-ahead-ms": 6_000,
    })).toEqual([expect.objectContaining({
      eventKey: "gap-ahead-closing",
      subjectId: "7",
      payload: { competitorIndex: 7, gapSeconds: 6, previousGapSeconds: 8, changeSeconds: -2 },
    })]);
    expect(consume(20, { "timing.gap-ahead-ms": 4_000, "timing.gap-behind-ms": 7_000 }))
      .toEqual([expect.objectContaining({ eventKey: "gap-behind-growing", payload: {
        competitorIndex: 9, gapSeconds: 7, previousGapSeconds: 4, changeSeconds: 3,
      } })]);
    expect(consume(30, { "timing.gap-ahead-ms": 7_000, "timing.gap-behind-ms": 7_000 })).toEqual([]);
    expect(consume(40, { "timing.gap-ahead-ms": 9_000, "timing.gap-behind-ms": 7_000 }))
      .toEqual([expect.objectContaining({ eventKey: "gap-ahead-growing", payload: {
        competitorIndex: 7, gapSeconds: 9, previousGapSeconds: 7, changeSeconds: 2,
      } })]);
    expect(consume(50, { "timing.gap-ahead-ms": 9_400, "timing.gap-behind-ms": 7_000 })).toEqual([]);
    expect(consume(60, { "timing.gap-ahead-ms": 11_000, "timing.gap-behind-ms": 7_000 })).toEqual([]);
    expect(consume(70, { "timing.gap-ahead-ms": 11_000, "timing.gap-behind-ms": 5_000 }))
      .toEqual([expect.objectContaining({ eventKey: "gap-behind-closing", payload: {
        competitorIndex: 9, gapSeconds: 5, previousGapSeconds: 7, changeSeconds: -2,
      } })]);
  });

  test("rejects mismatched or duplicate rosters and reseeds a replacement neighbor", () => {
    const state = createPreviousValueState();
    const consume = (seconds: number, overrides: Record<string, unknown> = {}) =>
      run(triggerTimings, state, seconds, timingValues(overrides));
    expect(consume(0)).toEqual([]);
    expect(consume(10, { "race.competitor.car-index": [0, 7, 7], "timing.gap-ahead-ms": 2_000 })).toEqual([]);
    expect(consume(20, { "timing.gap-ahead-ms": 5_000 })).toEqual([]);
    expect(consume(30, { "timing.gap-ahead-ms": 4_000 }).map(event => event.eventKey)).toEqual(["gap-ahead-closing"]);
    expect(consume(40, { "race.competitor.driver-id": ["0:0", "7:0"] })).toEqual([]);
    expect(consume(50, { "timing.gap-ahead-ms": 3_000 })).toEqual([]);
    const replacement = {
      "race.competitor.car-index": [0, 8, 9],
      "race.competitor.driver-id": ["0:0", "8:0", "9:0"],
    };
    expect(consume(60, { ...replacement, "timing.gap-ahead-ms": 1_000 })).toEqual([]);
    expect(consume(70, { ...replacement, "timing.gap-ahead-ms": 2_000 }))
      .toEqual([expect.objectContaining({ eventKey: "gap-ahead-growing", payload: {
        competitorIndex: 8, gapSeconds: 2, previousGapSeconds: 1, changeSeconds: 1,
      } })]);
    expect(consume(80, { "race.competitor.position": [2, 1, 1] })).toEqual([]);
    expect(consume(90, { "timing.gap-ahead-ms": 2_000 })).toEqual([]);
  });

  test("does not compare gaps across caution, pit, invalid samples, or timeline rewind", () => {
    const state = createPreviousValueState();
    const consume = (seconds: number, overrides: Record<string, unknown> = {}) =>
      run(triggerTimings, state, seconds, timingValues(overrides));
    consume(0);
    expect(consume(10, { "race.flag-status": "yellow", "timing.gap-ahead-ms": 1_000 })).toEqual([]);
    expect(consume(20, { "timing.gap-ahead-ms": 2_000 })).toEqual([]);
    expect(consume(30, { "race.competitor.pit-status": ["out", "pit_lane", "out"] })).toEqual([]);
    expect(consume(40, { "timing.gap-ahead-ms": 1_000 })).toEqual([]);
    expect(consume(50, { "timing.gap-ahead-ms": -1, "timing.gap-behind-ms": 999_999 })).toEqual([]);
    expect(consume(60, { "timing.gap-ahead-ms": 6_000 })).toEqual([]);
    expect(consume(10, { "timing.gap-ahead-ms": 1_000 })).toEqual([]);
    expect(consume(20, { "timing.gap-ahead-ms": 2_000 }).map(event => event.eventKey)).toEqual(["gap-ahead-growing"]);
  });

  test("reports actual same-car driver replacement, not reorder or newly joined cars", () => {
    const state = createPreviousValueState();
    const consume = (seconds: number, overrides: Record<string, unknown> = {}) =>
      run(triggerDriverSwaps, state, seconds, timingValues(overrides));
    expect(consume(0)).toEqual([]);
    expect(consume(1, {
      "race.competitor.car-index": [9, 0, 7],
      "race.competitor.driver-id": ["9:0", "0:0", "7:0"],
    })).toEqual([]);
    const swapped = { "race.competitor.driver-id": ["0:0", "7:1", "9:0"] };
    expect(consume(2, swapped)).toEqual([expect.objectContaining({
      eventKey: "driver-changed", subjectId: "7",
      payload: { competitorIndex: 7, previousDriverId: "7:0", driverId: "7:1" },
    })]);
    expect(consume(3, swapped)).toEqual([]);
    expect(consume(4, {
      "race.competitor.car-index": [0, 8, 9],
      "race.competitor.driver-id": ["0:0", "8:0", "9:0"],
    })).toEqual([]);
    expect(consume(5, swapped)).toEqual([]);
  });

  test("driver swaps never bridge disconnected, malformed, missing-driver or reset baselines", () => {
    const state = createPreviousValueState();
    const consume = (seconds: number, overrides: Record<string, unknown> = {}) =>
      run(triggerDriverSwaps, state, seconds, timingValues(overrides));
    consume(0);
    expect(consume(1, { "race.competitor.connected": [true, false, true] })).toEqual([]);
    const swapped = { "race.competitor.driver-id": ["0:0", "7:1", "9:0"] };
    expect(consume(2, swapped)).toEqual([]);
    expect(consume(3, { "race.competitor.driver-id": ["0:0"] })).toEqual([]);
    expect(consume(4)).toEqual([]);
    expect(consume(5, { "race.competitor.driver-id": ["0:0", "", "9:0"] })).toEqual([]);
    expect(consume(6, swapped)).toEqual([]);
    expect(consume(7, { "race.competitor.car-index": [0, 7, 7] })).toEqual([]);
    expect(consume(8)).toEqual([]);
    expect(consume(2, swapped)).toEqual([]);
    expect(run(triggerDriverSwaps, createPreviousValueState(), 3, timingValues())).toEqual([]);
  });

  test("catalog reset does not turn previous gaps or drivers into historical events", () => {
    const catalog = new CrewChiefTriggerCatalog();
    const relevant = (seconds: number, overrides: Record<string, unknown> = {}) =>
      events(catalog, frame(seconds, timingValues(overrides))).filter(event => event.family === "Timings" || event.family === "DriverSwaps");
    expect(relevant(0)).toEqual([]);
    expect(relevant(10, { "timing.gap-ahead-ms": 6_000 }).map(event => event.eventKey)).toEqual(["gap-ahead-closing"]);
    catalog.reset();
    expect(relevant(20, {
      "timing.gap-ahead-ms": 2_000,
      "race.competitor.driver-id": ["0:0", "7:1", "9:0"],
    })).toEqual([]);
  });

  test("broadcast realtime driver index supplies swap identity and name despite stale entry-list index", () => {
    let now = 0;
    const broadcast = new AccBroadcastState({ now: () => now });
    broadcast.setSocketConnected(true);
    broadcast.apply({ type: "registration-result", connectionId: 1, success: true, readOnly: true, error: "" });
    broadcast.apply({ type: "entry-list", connectionId: 1, carIndexes: [7] });
    broadcast.apply({
      type: "realtime-update", eventIndex: 1, sessionIndex: 1, sessionType: 10, phase: 5,
      sessionTimeMs: 0, sessionEndTimeMs: 0, focusedCarIndex: 7,
      activeCameraSet: "", activeCamera: "", currentHudPage: "", replayPlaying: false,
      bestSessionLap: { timeMs: null, carIndex: 7, driverIndex: 0, splitsMs: [], isInvalid: true, isValidForBest: false, isOutlap: false, isInlap: false },
    });
    broadcast.apply({
      type: "entry-list-car", carIndex: 7, carModelType: 1, teamName: "Team", raceNumber: 7,
      cupCategory: 0, currentDriverIndex: 0, nationality: 1,
      drivers: [
        { firstName: "First", lastName: "Driver", shortName: "ONE", category: 0, nationality: 1 },
        { firstName: "Second", lastName: "Driver", shortName: "TWO", category: 0, nationality: 1 },
      ],
    });
    const car: AccBroadcastCar = {
      carIndex: 7, driverIndex: 0, driverCount: 2, gear: 1, worldPosX: 0, worldPosY: 0,
      yaw: 0, location: 2, kmh: 0, position: 3, cupPosition: 3, splinePosition: 0.1,
      laps: 4, deltaMs: 0, bestLapTimeMs: 90_000, lastLapTimeMs: 91_000,
      lastLapValid: true, currentLapTimeMs: 10_000,
    };
    const state = createPreviousValueState();
    const update = (driverIndex: number) => {
      broadcast.apply({ type: "realtime-car-update", ...car, driverIndex });
      const snapshot = broadcast.snapshot().extension;
      return {
        snapshot,
        events: run(triggerDriverSwaps, state, now / 1000, {
          "race.competitor.car-index": snapshot?.carIndex,
          "race.competitor.driver-id": snapshot?.driverId,
          "race.competitor.connected": snapshot?.connected,
        }),
      };
    };
    expect(update(0).events).toEqual([]);
    now = 1000;
    const swapped = update(1);
    expect(swapped.snapshot?.driverName).toEqual(["Second Driver"]);
    expect(swapped.events).toEqual([expect.objectContaining({
      eventKey: "driver-changed", payload: { competitorIndex: 7, previousDriverId: "7:0", driverId: "7:1" },
    })]);
    now = 2000;
    expect(update(1).events).toEqual([]);
    now = 3000;
    expect(update(255).events).toEqual([]);
    now = 4000;
    expect(update(0).events).toEqual([]);
  });

  test("does not invent watched opponents, unsupported ratings, or new F1 branches", () => {
    for (const trigger of [triggerWatchedOpponents, triggerRatings]) {
      const state = createPreviousValueState();
      expect(run(trigger, state, 0, timingValues({ "race.competitor.rating": [100, 200, 300] }))).toEqual([]);
      expect(run(trigger, state, 10, timingValues({
        "race.competitor.driver-id": ["0:0", "7:1", "9:0"],
        "race.competitor.rating": [200, 300, 400],
      }))).toEqual([]);
    }
    for (const trigger of [triggerTimings, triggerDriverSwaps]) {
      const state = createPreviousValueState();
      expect(run(trigger, state, 0, timingValues(), "f1-2025")).toEqual([]);
      expect(run(trigger, state, 10, timingValues({
        "timing.gap-ahead-ms": 1_000,
        "race.competitor.driver-id": ["0:0", "7:1", "9:0"],
      }), "f1-2025")).toEqual([]);
    }
  });
});
