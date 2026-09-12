import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

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

  test("keeps Timings, WatchedOpponents, Ratings, and DriverSwaps silent without source configuration", () => {
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
