import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { CrewChiefTriggerBatchV1 } from "../../../server/live-strategy/crewchief-triggers/contracts";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

const value = (semanticId: string, current: unknown): ResolvedValue<unknown> => ({
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

const frame = (sequence: number, overrides: Record<string, unknown> = {}): LiveResolvedSemanticFrame => {
  const entries: readonly [string, unknown][] = [
    ["session.session-state", 5],
    ["timing.session-time-remain", 1_200_000],
    ["race.race-position", 4],
    ["identity.player-car-class-id", "gt3"],
    ["race.competitor.car-class-id", ["gt3", "gt3", "gt3"]],
    ["timing.lap-number", 1],
    ["timing.last-lap", 0],
    ["timing.current-lap-valid", true],
    ["race.pit-status", false],
    ["race.flag-status", "green"],
    ["identity.car-left-right", 0],
    ...Object.entries(overrides),
  ];
  return {
    simulator: "acc",
    sessionId: 7,
    streamId: "acc-session",
    sequence,
    observedAt: { domain: "wall-clock", milliseconds: sequence * 1000 },
    ids: entries.map(([id]) => id),
    values: entries.map(([id, current]) => value(id, current)),
  };
};

const eventsFor = (batch: CrewChiefTriggerBatchV1, family: string) => batch.events.filter((event) => event.family === family);

describe("CrewChief ACC session triggers", () => {
  test("arms first frame silently, then emits one single-class position change without repeating", () => {
    const catalog = new CrewChiefTriggerCatalog();
    expect(catalog.consume(frame(0)).events).toEqual([]);

    const changed = catalog.consume(frame(1, { "race.race-position": 3 }));
    expect(eventsFor(changed, "Position")).toHaveLength(1);
    expect(eventsFor(changed, "Position")[0]).toMatchObject({
      eventKey: "position-changed",
      payload: { position: 3 },
    });
    expect(eventsFor(catalog.consume(frame(2, { "race.race-position": 3 })), "Position")).toEqual([]);
  });

  test("emits LapCounter pre-lights then green once across Formation to Green", () => {
    const catalog = new CrewChiefTriggerCatalog();
    expect(catalog.consume(frame(0, { "session.session-state": 2 })).events).toEqual([]);

    const formation = catalog.consume(frame(1, { "session.session-state": 3 }));
    expect(eventsFor(formation, "LapCounter")).toMatchObject([
      { eventKey: "pre-lights" },
    ]);

    const green = catalog.consume(frame(2, { "session.session-state": 5 }));
    expect(eventsFor(green, "LapCounter")).toMatchObject([
      { eventKey: "green-flag" },
    ]);
    expect(eventsFor(catalog.consume(frame(3, { "session.session-state": 5 })), "LapCounter")).toEqual([]);
  });

  test("keeps unavailable RaceTime, FrozenOrderMonitor, and SessionEndMessages silent as watched values change", () => {
    const catalog = new CrewChiefTriggerCatalog();
    catalog.consume(frame(0, { "session.session-state": 2, "timing.session-time-remain": 900_000, "race.race-position": 4 }));
    const changed = catalog.consume(frame(1, { "session.session-state": 5, "timing.session-time-remain": 0, "race.race-position": 1 }));

    expect(eventsFor(changed, "RaceTime")).toEqual([]);
    expect(eventsFor(changed, "FrozenOrderMonitor")).toEqual([]);
    expect(eventsFor(changed, "SessionEndMessages")).toEqual([]);
  });
});
