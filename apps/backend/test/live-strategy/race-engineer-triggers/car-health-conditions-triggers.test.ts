import { describe, expect, test } from "bun:test";
import type { LiveResolvedSemanticFrame } from "@raceiq/telemetry-core/telemetry/live-projector";
import { RaceEngineerTriggerCatalog } from "@raceiq/backend-core/live-strategy/race-engineer-triggers/catalog";
import type { ResolvedValue } from "@raceiq/shared/telemetry/resolver/contracts";
import { LiveEngineerVoiceEngine } from "@raceiq/backend-core/live-strategy/live-engineer-voice-engine";
import type { LiveEngineerCalloutMessageV3, LiveEngineerVoiceLineMessageV3 } from "@raceiq/shared/racing/live/engineer-contracts";

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

  test("reports each damaged zone after three seconds without repeating unchanged damage", () => {
    const c = new RaceEngineerTriggerCatalog();
    const damage = {
      "damage.car-damage-front": 0.2,
      "damage.car-damage-rear": 0.1,
      "damage.car-damage-left": 0,
      "damage.car-damage-right": 0,
      "damage.car-damage-centre": 0,
    };
    c.consume(frame(0, 0, damage));
    expect(keys(c, frame(1, 2.99, damage), "DamageReporting")).toEqual([]);
    expect(events(c, frame(2, 3, damage))).toContainEqual(expect.objectContaining({ family: "DamageReporting", payload: expect.objectContaining({ location: "front" }) }));
    expect(events(c, frame(3, 4, damage))).toContainEqual(expect.objectContaining({ family: "DamageReporting", payload: expect.objectContaining({ location: "rear" }) }));
    expect(keys(c, frame(4, 5, damage), "DamageReporting")).toEqual([]);
  });

  test("maps F1 aero damage percentages to existing callout zones", () => {
    const c = new RaceEngineerTriggerCatalog();
    const f1Damage = {
      "damage.front-left-wing-damage": 20,
      "damage.front-right-wing-damage": 10,
      "damage.rear-wing-damage": 0,
      "damage.floor-damage": 0,
      "damage.diffuser-damage": 0,
      "damage.sidepod-damage": 0,
    };
    const f1Frame = (sequence: number, seconds: number): LiveResolvedSemanticFrame => ({
      ...frame(sequence, seconds, f1Damage),
      simulator: "f1-2025",
    });

    c.consume(f1Frame(0, 0));
    expect(keys(c, f1Frame(1, 2.99), "DamageReporting")).toEqual([]);
    const reported = events(c, f1Frame(2, 3)).find((event) => event.family === "DamageReporting");
    expect(reported).toMatchObject({ eventKey: "damage-reported", payload: { front: 0.2, rear: 0, centre: 0 } });
    expect(keys(c, f1Frame(3, 4), "DamageReporting")).toEqual([]);
  });

  test.each(["acc", "ac-evo", "f1-2025"] as const)("%s damage reaches voice delivery on new zones, escalation, and repair", (simulator) => {
    const catalog = new RaceEngineerTriggerCatalog();
    const emitted: (LiveEngineerCalloutMessageV3 | LiveEngineerVoiceLineMessageV3)[] = [];
    const engine = new LiveEngineerVoiceEngine({ emit: (message) => emitted.push(message) });
    let sequence = 0;
    const consume = (seconds: number, front: number, rear = 0, sessionId = 1, unavailable: "stale" | "missing" | false = false) => {
      const values = simulator === "f1-2025" ? {
        "damage.front-left-wing-damage": front * 100, "damage.front-right-wing-damage": 0,
        "damage.rear-wing-damage": rear * 100, "damage.floor-damage": 0,
        "damage.diffuser-damage": 0, "damage.sidepod-damage": 0,
      } : {
        "damage.car-damage-front": front, "damage.car-damage-rear": rear,
        "damage.car-damage-left": 0, "damage.car-damage-right": 0, "damage.car-damage-centre": 0,
      };
      const source = { ...frame(sequence++, seconds, values), simulator, sessionId };
      if (unavailable) source.values = source.values.map((value) => value.semanticId.startsWith("damage.") ? unavailable === "stale" ? { ...value, freshness: "stale" } : { ...value, state: "missing", value: null } : value);
      emitted.length = 0;
      engine.consume(catalog.consume(source));
      return emitted.filter((message): message is LiveEngineerVoiceLineMessageV3 => message.type === "live-engineer-voice-line").flatMap((message) => [...message.segmentIds]);
    };
    expect(consume(0, .05)).toEqual([]);
    expect(consume(.1, .2)).toEqual([]);
    expect(consume(.2, .05)).toEqual([]);
    expect(consume(1, .2)).toEqual([]);
    expect(consume(3.99, .2)).toEqual([]);
    expect(consume(4, .2)).toEqual(["race-engineer.damage-front"]);
    expect(consume(5, .29)).toEqual([]);
    expect(consume(6, .3)).toEqual([]);
    expect(consume(8.99, .3)).toEqual([]);
    expect(consume(9, .3)).toEqual(["race-engineer.damage-heavy-front"]);
    expect(consume(10, .3, .1)).toEqual([]);
    // Previously reported front remains worse, but new rear damage must get its own line.
    expect(consume(13, .3, .1)).toEqual(["race-engineer.damage-rear"]);
    expect(consume(14, 0, .1)).toEqual([]);
    expect(consume(15, .2, .1)).toEqual([]);
    expect(consume(18, .2, .1)).toEqual(["race-engineer.damage-front"]);
    expect(consume(19, .2, .1)).toEqual([]);
    expect(consume(20, .2, .1, 1, "stale")).toEqual([]);
    expect(consume(21, .2, .1)).toEqual([]);
    expect(consume(23.99, .2, .1)).toEqual([]);
    expect(consume(24, .2, .1)).toEqual(["race-engineer.damage-front"]);
    expect(consume(25, .2, .1, 2)).toEqual([]);
    expect(consume(27.99, .2, .1, 2)).toEqual([]);
    expect(consume(28, .2, .1, 2)).toEqual(["race-engineer.damage-front"]);
    expect(consume(29, .2, .1, 2, "missing")).toEqual([]);
    expect(consume(30, .2, .1, 2)).toEqual([]);
    expect(consume(32.99, .2, .1, 2)).toEqual([]);
    expect(consume(33, .2, .1, 2)).toEqual(["race-engineer.damage-front"]);
  });

  test("samples rain for ten seconds, emits bucket transitions once, and ignores unchanged readings", () => {
    const c = new RaceEngineerTriggerCatalog();
    c.consume(frame(0, 0, { "weather.rain-intensity-code": 0 }));
    expect(keys(c, frame(1, 9.9, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toEqual([]);
    expect(keys(c, frame(2, 10, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toContain("rain-changed");
    expect(keys(c, frame(3, 20, { "weather.rain-intensity-code": 2 }), "ConditionsMonitor")).toEqual([]);
  });
});
