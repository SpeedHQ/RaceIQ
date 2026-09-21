import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import { createPreviousValueState, type PreviousValueState } from "../../../server/live-strategy/crewchief-triggers/common";
import type { CrewChiefTriggerFunction } from "../../../server/live-strategy/crewchief-triggers/contracts";
import { CrewChiefTriggerFrame } from "../../../server/live-strategy/crewchief-triggers/frame";
import { triggerOvertakingAidsMonitor, triggerPenalties } from "../../../server/live-strategy/crewchief-triggers/race-control-triggers";
import { triggerFuel, triggerPushNow, triggerStrategy } from "../../../server/live-strategy/crewchief-triggers/strategy-triggers";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

const value = (semanticId: string, current: unknown): ResolvedValue<unknown> => ({ semanticId, value: current, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 }, provenance: {} as ResolvedValue<unknown>["provenance"], schemaVersion: "test", limitations: [] });
const frame = (sequence: number, observedAt: number, changes: Record<string, unknown> = {}, streamId = "strategy"): LiveResolvedSemanticFrame => {
  const entries: readonly [string, unknown][] = [
    ["session.session-state", 5], ["race.pit-status", "out"], ["race.flag-status", "green"],
    ["fuel.remaining-volume", 50], ["fuel.fuel-per-lap", 10], ["race.penalty-code", 0], ...Object.entries(changes),
  ];
  return { simulator: "acc", sessionId: 1, streamId, sequence, observedAt: { domain: "wall-clock", milliseconds: observedAt }, ids: entries.map(([id]) => id), values: entries.map(([id, current]) => value(id, current)) };
};
const keys = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame) => catalog.consume(source).events.map((event) => event.eventKey);
const familyKeys = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame, family: string) =>
  catalog.consume(source).events.filter((event) => event.family === family).map((event) => event.eventKey);

const detector = (trigger: CrewChiefTriggerFunction<PreviousValueState>, simulator: LiveResolvedSemanticFrame["simulator"], defaults: Record<string, unknown>) => {
  let state = createPreviousValueState();
  let sequence = 0;
  return {
    reset: () => { state = createPreviousValueState(); },
    consume(changes: Record<string, unknown> = {}) {
      const source = { ...frame(sequence++, 0, { ...defaults, ...changes }), simulator };
      const projected = new CrewChiefTriggerFrame(source);
      const result = trigger({ frame: projected, context: projected.context(), sessionTimeMs: sequence * 1000 }, state);
      return result === null ? [] : "eventKey" in result ? [result] : result;
    },
  };
};
const accRace = {
  "session.session-type": "race", "session.session-state": 5,
  "race.is-race-on": true,
  "timing.session-time-remain": 600, "timing.last-lap": 100,
  "fuel.remaining-volume": 100, "fuel.fuel-per-lap": 10,
};
const evoRace = {
  "session.session-type": "race", "session.session-state": undefined, "race.is-race-on": true,
  "race.is-timed-race": true, "timing.session-time-left-ms": 600_000, "timing.last-lap": 100,
  "timing.total-laps": 20, "timing.lap-number": 18, "fuel.laps-remaining": 10,
};

 describe("CrewChief ACC race-control and strategy triggers", () => {
  test("ACC penalty enums emit on changed nonzero codes, not numeric increases", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    expect(keys(catalog, frame(1, 1000, { "race.penalty-code": 3 }))).toEqual(["penalty-issued"]);
    expect(keys(catalog, frame(2, 2000, { "race.penalty-code": 1 }))).toEqual(["penalty-issued"]);
    expect(keys(catalog, frame(3, 3000, { "race.penalty-code": 1 }))).toEqual([]);
    expect(keys(catalog, frame(4, 4000, { "race.penalty-code": 0 }))).toEqual([]);
    expect(keys(catalog, frame(5, 5000, { "race.penalty-code": 1 }))).toEqual(["penalty-issued"]);
  });

  test("pit out to pit_lane to out emits exactly pit-entry and pit-exit", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    expect(keys(catalog, frame(1, 1000, { "race.pit-status": "pit_lane" }))).toEqual(["pit-entry"]);
    expect(keys(catalog, frame(2, 2000, { "race.pit-status": "out" }))).toEqual(["pit-exit"]);
  });

  test("fuel threshold crossings emit low then critical once and reset after recovery", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    expect(keys(catalog, frame(1, 1000, { "fuel.remaining-volume": 19 }))).toEqual(["fuel-low"]);
    expect(keys(catalog, frame(2, 2000, { "fuel.remaining-volume": 9 }))).toEqual(["fuel-critical"]);
    expect(keys(catalog, frame(3, 3000, { "fuel.remaining-volume": 8 }))).toEqual([]);
    expect(keys(catalog, frame(4, 4000, { "fuel.remaining-volume": 50 }))).toEqual([]);
    expect(keys(catalog, frame(5, 5000, { "fuel.remaining-volume": 19 }))).toEqual(["fuel-low"]);
  });

  test("flag change emits after ACC stable-settle interval, but not during pit or formation", () => {
    const catalog = new CrewChiefTriggerCatalog();
    familyKeys(catalog, frame(0, 0), "FlagsMonitor");
    expect(familyKeys(catalog, frame(1, 100, { "race.flag-status": "yellow" }), "FlagsMonitor")).toEqual([]);
    expect(familyKeys(catalog, frame(2, 1000, { "race.flag-status": "yellow" }), "FlagsMonitor")).toEqual([]);
    expect(familyKeys(catalog, frame(3, 2500, { "race.flag-status": "yellow" }), "FlagsMonitor")).toEqual(["flag-change"]);

    const suppressed = new CrewChiefTriggerCatalog();
    familyKeys(suppressed, frame(0, 0), "FlagsMonitor");
    expect(familyKeys(suppressed, frame(1, 2500, { "race.flag-status": "red", "race.pit-status": "pit_lane" }), "FlagsMonitor")).toEqual([]);
    expect(familyKeys(suppressed, frame(2, 5000, { "race.flag-status": "red", "session.session-state": 2 }), "FlagsMonitor")).toEqual([]);
  });

  test("ACC missing battery and overtaking sources stay static even with synthetic values", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    const changed = catalog.consume(frame(1, 1000, { "engine.battery-state-of-charge": 0.1, "race.player.push-to-pass-active": true, "aero.drs-active": true }));
    expect(changed.events.filter((event) => ["Battery", "OvertakingAidsMonitor"].includes(event.family))).toEqual([]);
    for (const family of ["Battery", "OvertakingAidsMonitor"] as const) {
      expect(catalog.capabilities("acc")[family]).toMatchObject({ state: "unavailable", reasonCode: "no-game-branch" });
    }
  });
});

describe("Source-backed strategy boundaries", () => {
  test("baseline fuel deficit and invalid consumption never invent a threshold crossing", () => {
    const fuel = detector(triggerFuel, "acc", { "fuel.remaining-volume": 9, "fuel.fuel-per-lap": 10 });
    expect(fuel.consume()).toEqual([]);
    expect(fuel.consume()).toEqual([]);
    expect(fuel.consume({ "fuel.remaining-volume": 30 })).toEqual([]);
    expect(fuel.consume({ "fuel.remaining-volume": 19 }).map((event) => event.eventKey)).toEqual(["fuel-low"]);
    expect(fuel.consume({ "fuel.fuel-per-lap": 0 })).toEqual([]);
    expect(fuel.consume()).toEqual([]);
    expect(fuel.consume()).toEqual([]);
  });
  test("F1 fuel-lap scenario calls out low then critical once across recovery", () => {
    const fuel = detector(triggerFuel, "f1-2025", { "fuel.laps-remaining": 3 });
    expect(fuel.consume()).toEqual([]);
    expect(fuel.consume({ "fuel.laps-remaining": 1.8 }).map((event) => event.eventKey)).toEqual(["fuel-low"]);
    expect(fuel.consume({ "fuel.laps-remaining": 0.8 }).map((event) => event.eventKey)).toEqual(["fuel-critical"]);
    expect(fuel.consume({ "fuel.laps-remaining": 0.7 })).toEqual([]);
    expect(fuel.consume({ "fuel.laps-remaining": 3 })).toEqual([]);
    expect(fuel.consume({ "fuel.laps-remaining": 1.5 }).map((event) => event.eventKey)).toEqual(["fuel-low"]);
  });


  test("ACC fuel-to-finish projection includes post-timer lap and hysteresis", () => {
    const strategy = detector(triggerStrategy, "acc", accRace);
    expect(strategy.consume()).toEqual([]);
    const deficit = { "timing.session-time-remain": 500, "fuel.remaining-volume": 50 };
    expect(strategy.consume(deficit)).toMatchObject([{ eventKey: "fuel-save-required", payload: { basis: "timed", estimatedRaceLapsRemaining: 6, fuelLapsRemaining: 5, reserveLaps: -1 } }]);
    expect(strategy.consume(deficit)).toEqual([]);
    expect(strategy.consume({ ...deficit, "fuel.remaining-volume": 62 })).toEqual([]);
    expect(strategy.consume({ ...deficit, "fuel.remaining-volume": 65 })).toMatchObject([{ eventKey: "fuel-to-finish", payload: { reserveLaps: 0.5 } }]);
    strategy.reset();
    expect(strategy.consume(deficit)).toEqual([]);
    expect(strategy.consume(deficit)).toEqual([]);
  });

  test("pit, caution, non-race and end states rebaseline strategy instead of delayed advice", () => {
    const strategy = detector(triggerStrategy, "acc", accRace);
    strategy.consume();
    const deficit = { "fuel.remaining-volume": 30 };
    expect(strategy.consume({ ...deficit, "race.pit-status": "pit_lane" })).toEqual([]);
    expect(strategy.consume(deficit)).toEqual([]);
    expect(strategy.consume({ ...deficit, "race.flag-status": "yellow" })).toEqual([]);
    expect(strategy.consume()).toEqual([]);
    expect(strategy.consume({ ...deficit, "session.session-state": 6 })).toEqual([]);
    expect(strategy.consume(deficit)).toEqual([]);
    expect(strategy.consume({ ...deficit, "session.session-type": "practice" })).toEqual([]);
    expect(strategy.consume()).toEqual([]);
  });

  test("ACC final push needs clock boundary and fuel reserve, then remains latched", () => {
    const push = detector(triggerPushNow, "acc", { ...accRace, "timing.session-time-remain": 201, "fuel.remaining-volume": 35 });
    expect(push.consume()).toEqual([]);
    const window = { "timing.session-time-remain": 200 };
    expect(push.consume(window)).toMatchObject([{ eventKey: "push-now", payload: { reason: "fuel-backed-finish", estimatedRaceLapsRemaining: 3, reserveLaps: 0.5 } }]);
    expect(push.consume(window)).toEqual([]);
    expect(push.consume({ ...window, "fuel.remaining-volume": 34 })).toEqual([]);
    expect(push.consume(window)).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 0 })).toEqual([]);
    push.reset();
    expect(push.consume(window)).toEqual([]);
    expect(push.consume(window)).toEqual([]);
  });

  test("invalid pace, missing timed-race mode and insufficient fuel cannot authorize push", () => {
    const push = detector(triggerPushNow, "acc", accRace);
    push.consume();
    expect(push.consume({ "timing.session-time-remain": 100, "timing.last-lap": 0 })).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 100, "fuel.remaining-volume": 5 })).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 100, "race.flag-status": "yellow" })).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 100 })).toEqual([]);
    const evo = detector(triggerPushNow, "ac-evo", evoRace);
    evo.consume();
    expect(evo.consume({ "race.is-timed-race": undefined, "timing.lap-number": 20 })).toEqual([]);
  });

  test("Evo timed race uses milliseconds and ignores misleading lap totals", () => {
    const push = detector(triggerPushNow, "ac-evo", { ...evoRace, "timing.session-time-left-ms": 201_000 });
    expect(push.consume()).toEqual([]);
    expect(push.consume({ "timing.lap-number": 20 })).toEqual([]);
    expect(push.consume({ "timing.session-time-left-ms": 200_000 })).toMatchObject([{ eventKey: "push-now", payload: { basis: "timed", estimatedRaceLapsRemaining: 3 } }]);
  });

  test("Evo lap race uses whole current lap without borrowing timed race clock", () => {
    const push = detector(triggerPushNow, "ac-evo", { ...evoRace, "race.is-timed-race": false, "fuel.laps-remaining": 3 });
    expect(push.consume()).toEqual([]);
    expect(push.consume({ "timing.lap-number": 19 })).toMatchObject([{ eventKey: "push-now", payload: { basis: "laps", estimatedRaceLapsRemaining: 2, reserveLaps: 1 } }]);
    expect(push.consume({ "timing.lap-number": 19 })).toEqual([]);
    expect(push.consume({ "timing.lap-number": 21 })).toEqual([]);
  });

  test("ACC solo captures work without broadcast phase but paused races stay silent", () => {
    const push = detector(triggerPushNow, "acc", { ...accRace, "session.session-state": undefined, "timing.session-time-remain": 201 });
    expect(push.consume()).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 200 })).toMatchObject([{ eventKey: "push-now" }]);
    push.reset();
    push.consume();
    expect(push.consume({ "timing.session-time-remain": 200, "race.is-race-on": false })).toEqual([]);
    expect(push.consume({ "timing.session-time-remain": 200 })).toEqual([]);
  });


  test("ACC invalid penalty code rebaselines while F1 still uses count increases", () => {
    const penalties = detector(triggerPenalties, "acc", { "race.penalty-code": 21 });
    expect(penalties.consume()).toEqual([]);
    expect(penalties.consume({ "race.penalty-code": 22 })).toEqual([]);
    expect(penalties.consume({ "race.penalty-code": 1 })).toEqual([]);
    expect(penalties.consume({ "race.penalty-code": 2 })).toMatchObject([{ eventKey: "penalty-issued", payload: { previousCode: 1, code: 2 } }]);
    const f1 = detector(triggerPenalties, "f1-2025", { "race.penalties": 2 });
    expect(f1.consume()).toEqual([]);
    expect(f1.consume({ "race.penalties": 1 })).toEqual([]);
    expect(f1.consume({ "race.penalties": 3 })).toMatchObject([{ eventKey: "penalty-issued", payload: { previous: 1, count: 3 } }]);
  });
});

describe("Native overtaking aid transitions", () => {
  test("Evo flap transitions do not invent availability and rebaseline after pits", () => {
    const aids = detector(triggerOvertakingAidsMonitor, "ac-evo", { ...evoRace, "aero.drs-active": false });
    expect(aids.consume()).toEqual([]);
    expect(aids.consume({ "aero.drs-active": true })).toMatchObject([{ eventKey: "drs-open", payload: { active: true } }]);
    expect(aids.consume({ "aero.drs-active": true })).toEqual([]);
    expect(aids.consume()).toMatchObject([{ eventKey: "drs-closed", payload: { active: false } }]);
    expect(aids.consume({ "aero.drs-active": true, "race.pit-status": "pit_lane" })).toEqual([]);
    expect(aids.consume({ "aero.drs-active": true })).toEqual([]);
    expect(aids.consume({ "aero.drs-active": "true" })).toEqual([]);
    expect(aids.consume()).toEqual([]);
  });


  test("new non-F1 branches leave F1 source values untouched", () => {
    for (const trigger of [triggerStrategy, triggerPushNow, triggerOvertakingAidsMonitor]) {
      const unsupported = detector(trigger, "f1-2025", { ...accRace, "aero.drs-active": false });
      expect(unsupported.consume()).toEqual([]);
      expect(unsupported.consume({ "aero.drs-active": true, "fuel.remaining-volume": 1, "timing.session-time-remain": 10 })).toEqual([]);
    }
  });
});
