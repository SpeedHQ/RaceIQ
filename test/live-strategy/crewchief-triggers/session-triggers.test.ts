import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { CrewChiefTriggerBatchV1, CrewChiefTriggerFunction } from "../../../server/live-strategy/crewchief-triggers/contracts";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";
import { CrewChiefTriggerFrame } from "../../../server/live-strategy/crewchief-triggers/frame";
import {
  createPreviousValueState,
  triggerFrozenOrderMonitor,
  triggerLapCounter,
  triggerPosition,
  triggerRaceTime,
  triggerSessionEndMessages,
  type SessionTriggerState,
} from "../../../server/live-strategy/crewchief-triggers/session-triggers";

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
    ["session.session-type", "race"],
    ["race.is-race-on", true],
    ["timing.session-time-remain", 1_200],
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

const detector = (trigger: CrewChiefTriggerFunction<SessionTriggerState>, simulator: LiveResolvedSemanticFrame["simulator"]) => {
  let state = createPreviousValueState();
  let sequence = 0;
  return {
    consume(overrides: Record<string, unknown> = {}) {
      const current = new CrewChiefTriggerFrame({ ...frame(sequence++, overrides), simulator });
      return trigger({ frame: current, context: current.context(), sessionTimeMs: current.sequence * 1000 }, state);
    },
    reset() {
      state = createPreviousValueState();
    },
  };
};

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

  test("announces F1 final lap once when current lap reaches race distance", () => {
    const catalog = new CrewChiefTriggerCatalog();
    const f1Frame = (sequence: number, lap: number): LiveResolvedSemanticFrame => ({
      ...frame(sequence, { "timing.lap-number": lap, "timing.total-laps": 5 }),
      simulator: "f1-2025",
    });

    expect(catalog.consume(f1Frame(0, 3)).events).toEqual([]);
    expect(eventsFor(catalog.consume(f1Frame(1, 4)), "LapCounter")).toEqual([]);
    expect(eventsFor(catalog.consume(f1Frame(2, 5)), "LapCounter")).toMatchObject([
      { eventKey: "final-lap", payload: { lap: 5, totalLaps: 5 } },
    ]);
    expect(eventsFor(catalog.consume(f1Frame(3, 5)), "LapCounter")).toEqual([]);
  });

  test("keeps FrozenOrderMonitor silent without actual target-order facts", () => {
    const catalog = new CrewChiefTriggerCatalog();
    catalog.consume(frame(0, { "session.session-state": 2, "race.race-position": 4 }));
    const changed = catalog.consume(frame(1, { "session.session-state": 5, "race.race-position": 1 }));
    expect(eventsFor(changed, "FrozenOrderMonitor")).toEqual([]);
  });
});

describe("CrewChief native session phases", () => {
  test("does not announce starts at baseline, after invalid phases, or on unsupported games", () => {
    const acc = detector(triggerLapCounter, "acc");
    expect(acc.consume({ "session.session-state": 5 })).toBeNull();
    expect(acc.consume({ "session.session-state": 4 })).toBeNull();
    expect(acc.consume({ "session.session-state": 5 })).toBeNull();
    expect(acc.consume({ "session.session-state": 99 })).toBeNull();
    expect(acc.consume({ "session.session-state": 5 })).toBeNull();
    acc.reset();
    expect(acc.consume({ "session.session-state": 4 })).toBeNull();
    expect(acc.consume({ "session.session-state": 5 })).toMatchObject({ eventKey: "green-flag" });

    for (const simulator of ["ac-evo", "fm-2023"] as const) {
      const unsupported = detector(triggerLapCounter, simulator);
      expect(unsupported.consume({ "session.session-state": 2 })).toBeNull();
      expect(unsupported.consume({ "session.session-state": 3 })).toBeNull();
      expect(unsupported.consume({ "session.session-state": 5 })).toBeNull();
    }
  });
});

describe("CrewChief RaceTime", () => {
  test("announces ACC second-based countdown crossings once, including sparse samples", () => {
    const run = detector(triggerRaceTime, "acc");
    expect(run.consume({ "timing.session-time-remain": 901 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 900 })).toMatchObject({
      eventKey: "race-time-remaining",
      payload: { remainingSeconds: 900, milestoneSeconds: 900, minutesRemaining: 15 },
      evidenceSemanticIds: ["timing.session-time-remain", "race.is-race-on", "session.session-type", "session.session-state"],
    });
    expect(run.consume({ "timing.session-time-remain": 899 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 600 })).toMatchObject({ payload: { minutesRemaining: 10 } });
    expect(run.consume({ "timing.session-time-remain": 1200 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 600 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 299 })).toMatchObject({ payload: { minutesRemaining: 5 } });
    expect(run.consume({ "timing.session-time-remain": 59 })).toMatchObject({ payload: { minutesRemaining: 1 } });
    expect(run.consume({ "timing.session-time-remain": 0 })).toBeNull();
  });

  test("starts a fresh silent baseline after unavailable input and explicit resets", () => {
    const run = detector(triggerRaceTime, "acc");
    expect(run.consume({ "timing.session-time-remain": 900 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 901 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 900 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": Number.NaN })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 121 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 120 })).toMatchObject({ payload: { minutesRemaining: 2 } });
    run.reset();
    expect(run.consume({ "timing.session-time-remain": 120 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 119 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": -1 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 61 })).toBeNull();
    expect(run.consume({ "timing.session-time-remain": 60 })).toMatchObject({ payload: { minutesRemaining: 1 } });
  });

  test("uses ACC shared-memory race facts without broadcast while respecting optional phases", () => {
    const run = detector(triggerRaceTime, "acc");
    const noBroadcast = { "session.session-state": undefined };
    expect(run.consume({ ...noBroadcast, "session.session-type": "practice", "timing.session-time-remain": 301 })).toBeNull();
    expect(run.consume({ ...noBroadcast, "session.session-type": "practice", "timing.session-time-remain": 300 })).toBeNull();
    expect(run.consume({ ...noBroadcast, "timing.session-time-remain": 121 })).toBeNull();
    expect(run.consume({ ...noBroadcast, "timing.session-time-remain": 120 })).toMatchObject({
      eventKey: "race-time-remaining",
      payload: { minutesRemaining: 2 },
      evidenceSemanticIds: ["timing.session-time-remain", "race.is-race-on", "session.session-type"],
    });
    expect(run.consume({ ...noBroadcast, "race.is-race-on": false, "timing.session-time-remain": 61 })).toBeNull();
    expect(run.consume({ ...noBroadcast, "race.is-race-on": false, "timing.session-time-remain": 60 })).toBeNull();
    expect(run.consume({ "session.session-state": 4, "timing.session-time-remain": 61 })).toBeNull();
    expect(run.consume({ "session.session-state": 4, "timing.session-time-remain": 60 })).toBeNull();
    expect(run.consume({ "session.session-state": 5, "timing.session-time-remain": 61 })).toBeNull();
    expect(run.consume({ "session.session-state": 6, "timing.session-time-remain": 60 })).toBeNull();
  });

  test("converts AC Evo milliseconds and requires an active timed race", () => {
    const run = detector(triggerRaceTime, "ac-evo");
    const timed = { "race.is-timed-race": true, "race.is-race-on": true };
    expect(run.consume({ ...timed, "timing.session-time-left-ms": 61_000 })).toBeNull();
    expect(run.consume({ ...timed, "timing.session-time-left-ms": 60_000 })).toMatchObject({
      eventKey: "race-time-remaining",
      payload: { remainingSeconds: 60, milestoneSeconds: 60, minutesRemaining: 1 },
      evidenceSemanticIds: ["timing.session-time-left-ms", "race.is-timed-race", "race.is-race-on"],
    });
    expect(run.consume({ ...timed, "timing.session-time-left-ms": 59_000 })).toBeNull();
    run.reset();
    expect(run.consume({ ...timed, "race.is-timed-race": false, "timing.session-time-left-ms": 61_000 })).toBeNull();
    expect(run.consume({ ...timed, "race.is-timed-race": false, "timing.session-time-left-ms": 60_000 })).toBeNull();
    expect(run.consume({ ...timed, "race.is-race-on": false, "timing.session-time-left-ms": 59_000 })).toBeNull();
  });
});

describe("CrewChief SessionEndMessages", () => {
  test("announces ACC SessionOver once, not again through PostSession and ResultUI", () => {
    const run = detector(triggerSessionEndMessages, "acc");
    expect(run.consume({ "session.session-state": 5 })).toBeNull();
    expect(run.consume({ "session.session-state": 6 })).toEqual({
      eventKey: "session-ended",
      severity: "info",
      payload: { sessionPhase: "finished" },
      evidenceSemanticIds: ["session.session-state"],
    });
    expect(run.consume({ "session.session-state": 7 })).toBeNull();
    expect(run.consume({ "session.session-state": 8 })).toBeNull();
    expect(run.consume({ "session.session-state": 5 })).toBeNull();
    expect(run.consume({ "session.session-state": 6 })).toBeNull();
  });

  test("suppresses joined terminal sessions, invalid gaps and abandoned formation; resets safely", () => {
    const run = detector(triggerSessionEndMessages, "acc");
    expect(run.consume({ "session.session-state": 6 })).toBeNull();
    expect(run.consume({ "session.session-state": 7 })).toBeNull();
    run.reset();
    expect(run.consume({ "session.session-state": 2 })).toBeNull();
    expect(run.consume({ "session.session-state": 6 })).toBeNull();
    run.reset();
    expect(run.consume({ "session.session-state": 5 })).toBeNull();
    expect(run.consume({ "session.session-state": 9 })).toBeNull();
    expect(run.consume({ "session.session-state": 6 })).toBeNull();
    run.reset();
    expect(run.consume({ "session.session-state": 5 })).toBeNull();
    expect(run.consume({ "session.session-state": 8 })).toMatchObject({ eventKey: "session-ended" });
  });

  test("leaves new F1 families and source-unavailable frozen order silent", () => {
    for (const trigger of [triggerRaceTime, triggerSessionEndMessages, triggerFrozenOrderMonitor]) {
      const run = detector(trigger, "f1-2025");
      expect(run.consume({ "session.session-state": 4, "timing.session-time-remain": 61 })).toBeNull();
      expect(run.consume({ "session.session-state": 6, "timing.session-time-remain": 60 })).toBeNull();
    }
    const unsupported = detector(triggerSessionEndMessages, "ac-evo");
    expect(unsupported.consume({ "session.session-state": 5 })).toBeNull();
    expect(unsupported.consume({ "session.session-state": 6 })).toBeNull();
  });
});

describe("CrewChief Forza overall position", () => {
  test("announces overall position without inventing a single-class grid", () => {
    const run = detector(triggerPosition, "fm-2023");
    const noClass = { "identity.player-car-class-id": undefined, "race.competitor.car-class-id": undefined };
    expect(run.consume({ ...noClass, "race.race-position": 4 })).toBeNull();
    expect(run.consume({ ...noClass, "race.race-position": 3 })).toEqual({
      eventKey: "position-changed",
      severity: "info",
      payload: { position: 3, scope: "overall" },
      evidenceSemanticIds: ["race.race-position"],
    });
    expect(run.consume({ ...noClass, "race.race-position": 3 })).toBeNull();
    expect(run.consume({ ...noClass, "race.race-position": 0 })).toBeNull();
    expect(run.consume({ ...noClass, "race.race-position": 2 })).toBeNull();
    expect(run.consume({ ...noClass, "race.race-position": 1 })).toMatchObject({ payload: { position: 1, scope: "overall" } });
    run.reset();
    expect(run.consume({ ...noClass, "race.race-position": 1 })).toBeNull();
    expect(run.consume({ ...noClass, "race.race-position": 2 })).toMatchObject({ payload: { position: 2, scope: "overall" } });
  });
});
