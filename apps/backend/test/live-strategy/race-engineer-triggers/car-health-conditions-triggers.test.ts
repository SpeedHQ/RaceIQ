import { describe, expect, test } from "bun:test";
import type { LiveResolvedSemanticFrame } from "@raceiq/telemetry-core/telemetry/live-projector";
import { RaceEngineerTriggerCatalog } from "@raceiq/backend-core/live-strategy/race-engineer-triggers/catalog";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import { LiveEngineerVoiceEngine } from "@raceiq/backend-core/live-strategy/live-engineer-voice-engine";
import type { LiveEngineerCalloutMessageV3, LiveEngineerVoiceLineMessageV3 } from "@raceiq/shared/racing/live/engineer-contracts";
import type { GameId } from "@raceiq/shared/games/ids";

const v = (semanticId: string, value: unknown): ResolvedValue<unknown> => ({ semanticId, value, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 }, provenance: {} as ResolvedValue<unknown>["provenance"], schemaVersion: "test", limitations: [] });
const frame = (sequence: number, seconds: number, values: Record<string, unknown>, pit = false): LiveResolvedSemanticFrame => {
  const entries: [string, unknown][] = [
    ["session.session-state", 5], ["timing.lap-number", 3], ["timing.lap-fraction", 0.9], ["timing.current-lap", 3],
    ["timing.sector.current-index", 2], ["race.flag-status", "green"], ["race.pit-status", pit], ["identity.player-car-class-id", "GT3"],
    ...Object.entries(values),
  ];
  return { simulator: "acc", sessionId: 1, streamId: "health", sequence, observedAt: { domain: "wall-clock", milliseconds: seconds * 1000 }, ids: entries.map(([id]) => id), values: entries.map(([id, value]) => v(id, value)) };
};
const events = (catalog: RaceEngineerTriggerCatalog, source: LiveResolvedSemanticFrame) => catalog.consume(source).events;
const keys = (catalog: RaceEngineerTriggerCatalog, source: LiveResolvedSemanticFrame, family: string) => events(catalog, source).filter((event) => event.family === family).map((event) => event.eventKey);

const tyres = (temperature: number[], lap: number) => ({ "tire.temperature.core": temperature, "timing.lap-number": lap, "timing.current-lap": lap });

function damageHarness(simulator: GameId) {
  const catalog = new RaceEngineerTriggerCatalog();
  const messages: (LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3)[] = [];
  const engine = new LiveEngineerVoiceEngine({ emit: (message) => messages.push(message) });
  let sequence = 0;
  return {
    catalog,
    consume(seconds: number, values: Record<string, unknown>, unavailable: Record<string, "stale" | "missing"> = {}, sessionId = 1) {
      const source = { ...frame(sequence++, seconds, values), simulator, sessionId };
      source.values = source.values.map((value) => unavailable[value.semanticId] === "stale" ? { ...value, freshness: "stale" } :
        unavailable[value.semanticId] === "missing" ? { ...value, state: "missing", value: null } : value);
      messages.length = 0;
      engine.consume(catalog.consume(source));
      return messages.filter((message): message is LiveEngineerVoiceLineMessageV3 => message.type === "live-engineer-voice-line").flatMap((message) => [...message.segmentIds]);
    },
  };
}

describe("ACC Race Engineer car-health and conditions triggers", () => {
  test("waits for two laps and sector 3, then emits tyre temperature buckets once per transition", () => {
    const c = new RaceEngineerTriggerCatalog();
    expect(keys(c, frame(0, 0, tyres([80, 80, 80, 80], 1)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(1, 60, tyres([80, 80, 80, 80], 2)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(2, 120, tyres([65, 65, 65, 65], 3)), "TyreMonitor")).toContain("tyres-cold");
    expect(keys(c, frame(3, 121, tyres([65, 65, 65, 65], 3)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(4, 180, tyres([105, 105, 105, 105], 3)), "TyreMonitor")).toContain("tyres-hot");
    expect(keys(c, frame(5, 240, tyres([185, 185, 185, 185], 3)), "TyreMonitor")).toContain("tyres-cooking");
  });

  test("keeps ACC tyre transitions suppressed in pit and before the final sector", () => {
    const catalog = new RaceEngineerTriggerCatalog();
    catalog.consume(frame(0, 0, tyres([80, 80, 80, 80], 1)));
    const cold = tyres([65, 65, 65, 65], 3);
    expect(keys(catalog, frame(1, 120, cold, true), "TyreMonitor")).toEqual([]);
    expect(keys(catalog, frame(2, 130, { ...cold, "timing.sector.current-index": 1 }), "TyreMonitor")).toEqual([]);
    expect(keys(catalog, frame(3, 140, cold), "TyreMonitor")).toEqual(["tyres-cold"]);
  });

  test("arms water warning after 120 seconds and clears only on safe transition, suppressed in pit", () => {
    const c = new RaceEngineerTriggerCatalog();
    c.consume(frame(0, 0, { "engine.coolant-temperature": 90 }));
    expect(keys(c, frame(1, 119, { "engine.coolant-temperature": 115 }), "EngineMonitor")).toEqual([]);
    expect(keys(c, frame(2, 120, { "engine.coolant-temperature": 115 }), "EngineMonitor")).toContain("water-temperature-hot");
    expect(keys(c, frame(3, 121, { "engine.coolant-temperature": 115 }, true), "EngineMonitor")).toEqual([]);
    expect(keys(c, frame(4, 180, { "engine.coolant-temperature": 90 }), "EngineMonitor")).toContain("water-temperature-clear");
  });

  test("names simultaneous F1 components independently, worst first, without repeating", () => {
    const h = damageHarness("f1-2025");
    const damage = { "damage.front-left-wing-damage": 20, "damage.front-right-wing-damage": 40, "damage.diffuser-damage": 80 };
    expect(h.consume(0, damage)).toEqual([]);
    expect(h.consume(2.999, damage)).toEqual([]);
    expect(h.consume(3, damage)).toEqual(["race-engineer.damage-heavy-diffuser"]);
    expect(h.consume(3.01, damage)).toEqual(["race-engineer.damage-heavy-front-right-wing"]);
    expect(h.consume(3.02, damage)).toEqual(["race-engineer.damage-front-left-wing"]);
    expect(h.consume(4, damage)).toEqual([]);
    expect(h.consume(5, { ...damage, "damage.front-left-wing-damage": 30 })).toEqual([]);
    expect(h.consume(8, { ...damage, "damage.front-left-wing-damage": 30 })).toEqual(["race-engineer.damage-heavy-front-left-wing"]);
  });

  test("isolates stale and invalid channels, restarts debounce, and respects percentage boundaries", () => {
    const h = damageHarness("f1-2025");
    const damage = { "damage.floor-damage": 20, "inputs.gear-box-damage": 5, "damage.tyres-damage": [0, 0, 0, 101] };
    h.consume(0, damage);
    expect(h.consume(2, damage, { "damage.floor-damage": "stale" })).toEqual([]);
    expect(h.consume(3, { ...damage, "inputs.gear-box-damage": 6 })).toEqual([]);
    expect(h.consume(5.999, { ...damage, "inputs.gear-box-damage": 6 })).toEqual([]);
    expect(h.consume(6, { ...damage, "inputs.gear-box-damage": 6 })).toEqual(["race-engineer.damage-floor"]);
    expect(h.consume(6.01, { ...damage, "inputs.gear-box-damage": 6 })).toEqual(["race-engineer.damage-gearbox"]);
    expect(h.consume(7, { "damage.tyres-damage": [0, 0, 0], "damage.front-left-wing-damage": NaN })).toEqual([]);
    expect(h.consume(11, { "damage.tyres-damage": [0, 0, 0], "damage.front-left-wing-damage": NaN })).toEqual([]);
  });

  test.each(["acc", "ac-evo"] as const)("%s bodywork never invents component or calibrated heavy severity", (simulator) => {
    const h = damageHarness(simulator);
    expect(h.consume(0, { "damage.car-damage-centre": 50 })).toEqual([]);
    expect(h.consume(3, { "damage.car-damage-centre": 50 })).toEqual(["race-engineer.damage-bodywork"]);
    expect(h.consume(4, { "damage.car-damage-centre": 1000 })).toEqual([]);
    expect(h.consume(7, { "damage.car-damage-centre": 1000, "damage.car-damage-front": .2 })).toEqual([]);
    expect(h.consume(10, { "damage.car-damage-centre": 1000, "damage.car-damage-front": .2 })).toEqual(["race-engineer.damage-front-bodywork"]);
    expect(h.consume(11, { "damage.car-damage-front": 0 })).toEqual([]);
    expect(h.consume(12, { "damage.car-damage-front": .2 })).toEqual([]);
    expect(h.consume(15, { "damage.car-damage-front": .2 })).toEqual(["race-engineer.damage-front-bodywork"]);
  });

  test("reports exact F1 brake corner and gives explicit engine failure precedence", () => {
    const h = damageHarness("f1-2025");
    const damage = { "damage.brakes-damage": [0, 0, 0, 30], "damage.engine-damage": 100, "engine.engine-blown": true };
    h.consume(0, damage);
    expect(h.consume(3, damage)).toEqual(["race-engineer.damage-engine-blown"]);
    expect(h.consume(3.01, damage)).toEqual(["race-engineer.damage-heavy-rear-right-brake"]);
    expect(h.consume(7, damage)).toEqual([]);
    expect(h.consume(8, { "damage.tyres-damage": [0, 6, 0, 0] })).toEqual([]);
    expect(h.consume(11, { "damage.tyres-damage": [0, 6, 0, 0] })).toEqual(["race-engineer.damage-front-right-tyre"]);
  });

  test("iRacing interprets warning bits and repair timers without calling limiter bits damage", () => {
    const h = damageHarness("iracing");
    expect(h.consume(0, { "engine.engine-warnings": 16 | 32, "race.pit-service.mandatory-repair-time-remaining": -1 })).toEqual([]);
    expect(h.consume(3, { "engine.engine-warnings": 16 | 32, "race.pit-service.mandatory-repair-time-remaining": -1 })).toEqual([]);
    expect(h.consume(4, { "engine.engine-warnings": 0x80000004, "race.pit-service.mandatory-repair-time-remaining": 12.5 })).toEqual([]);
    expect(h.consume(7, { "engine.engine-warnings": 0x80000004, "race.pit-service.mandatory-repair-time-remaining": 9.5 })).toEqual(["race-engineer.damage-oil-pressure-warning"]);
    expect(h.consume(7.01, { "race.pit-service.mandatory-repair-time-remaining": 9.49 })).toEqual(["race-engineer.damage-required-repairs"]);
    expect(h.consume(8, { "race.pit-service.mandatory-repair-time-remaining": 0 })).toEqual([]);
    expect(h.consume(9, { "race.pit-service.optional-repair-time-remaining": 3 })).toEqual([]);
    expect(h.consume(12, { "race.pit-service.optional-repair-time-remaining": .5 })).toEqual(["race-engineer.damage-optional-repairs"]);
  });

  test("LMU reports real wheel faults, suppresses redundant flat warning, and enables no unrelated systems", () => {
    const h = damageHarness("lmu");
    const damage = { "tires.wheel-flat": [true, true, false, false], "tires.wheel-detached": [true, false, false, false] };
    h.consume(0, damage);
    expect(h.consume(3, damage)).toEqual(["race-engineer.damage-front-left-wheel-detached"]);
    expect(h.consume(3.01, damage)).toEqual(["race-engineer.damage-front-right-tyre-flat"]);
    expect(h.consume(7, damage)).toEqual([]);
    const active = Object.entries(h.catalog.capabilities("lmu")).filter(([, capability]) => capability.state !== "unavailable").map(([family]) => family);
    expect(active).toEqual(["DamageReporting"]);
  });

  test("source loss and session reset requalify damage while unsupported Forza stays silent", () => {
    const h = damageHarness("f1-2025");
    const damage = { "damage.rear-wing-damage": 20 };
    h.consume(0, damage);
    expect(h.consume(3, damage)).toEqual(["race-engineer.damage-rear-wing"]);
    expect(h.consume(4, damage, { "damage.rear-wing-damage": "missing" })).toEqual([]);
    expect(h.consume(5, damage)).toEqual([]);
    expect(h.consume(7.999, damage)).toEqual([]);
    expect(h.consume(8, damage)).toEqual(["race-engineer.damage-rear-wing"]);
    expect(h.consume(9, damage, {}, 2)).toEqual([]);
    expect(h.consume(12, damage, {}, 2)).toEqual(["race-engineer.damage-rear-wing"]);
    const forza = damageHarness("fm-2023");
    expect(forza.consume(0, damage)).toEqual([]);
    expect(forza.consume(4, damage)).toEqual([]);
  });

  test("samples rain for ten seconds, emits bucket transitions once, and ignores unchanged readings", () => {
    const c = new RaceEngineerTriggerCatalog();
    c.consume(frame(0, 0, { "weather.rain-intensity-code": 0 }));
    expect(keys(c, frame(1, 9.9, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toEqual([]);
    expect(keys(c, frame(2, 10, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toContain("rain-changed");
    expect(keys(c, frame(3, 20, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toEqual([]);
  });
});
