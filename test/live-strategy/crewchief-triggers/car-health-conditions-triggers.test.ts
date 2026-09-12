import { describe, expect, test } from "bun:test";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

const v = (semanticId: string, value: unknown): ResolvedValue<unknown> => ({ semanticId, value, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 }, provenance: {} as ResolvedValue<unknown>["provenance"], schemaVersion: "test", limitations: [] });
const frame = (sequence: number, seconds: number, values: Record<string, unknown>, pit = false): LiveResolvedSemanticFrame => {
  const entries: [string, unknown][] = [
    ["session.session-state", 5], ["timing.lap-number", 3], ["timing.lap-fraction", 0.9], ["timing.current-lap", 3],
    ["timing.sector.current-index", 2], ["race.flag-status", "green"], ["race.pit-status", pit], ["identity.player-car-class-id", "GT3"],
    ...Object.entries(values),
  ];
  return { simulator: "acc", sessionId: 1, streamId: "health", sequence, observedAt: { domain: "wall-clock", milliseconds: seconds * 1000 }, ids: entries.map(([id]) => id), values: entries.map(([id, value]) => v(id, value)) };
};
const events = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame) => catalog.consume(source).events;
const keys = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame, family: string) => events(catalog, source).filter((event) => event.family === family).map((event) => event.eventKey);

const tyres = (temperature: number[], lap: number) => ({ "tire.temperature.average": temperature, "timing.lap-number": lap, "timing.current-lap": lap });

describe("ACC CrewChief car-health and conditions triggers", () => {
  test("waits for two laps and sector 3, then emits tyre temperature buckets once per transition", () => {
    const c = new CrewChiefTriggerCatalog();
    expect(keys(c, frame(0, 0, tyres([80, 80, 80, 80], 1)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(1, 60, tyres([80, 80, 80, 80], 2)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(2, 120, tyres([65, 65, 65, 65], 3)), "TyreMonitor")).toContain("tyres-cold");
    expect(keys(c, frame(3, 121, tyres([65, 65, 65, 65], 3)), "TyreMonitor")).toEqual([]);
    expect(keys(c, frame(4, 180, tyres([105, 105, 105, 105], 3)), "TyreMonitor")).toContain("tyres-hot");
    expect(keys(c, frame(5, 240, tyres([185, 185, 185, 185], 3)), "TyreMonitor")).toContain("tyres-cooking");
  });

  test("arms water warning after 120 seconds and clears only on safe transition, suppressed in pit", () => {
    const c = new CrewChiefTriggerCatalog();
    c.consume(frame(0, 0, { "engine.coolant-temperature": 90 }));
    expect(keys(c, frame(1, 119, { "engine.coolant-temperature": 115 }), "EngineMonitor")).toEqual([]);
    expect(keys(c, frame(2, 120, { "engine.coolant-temperature": 115 }), "EngineMonitor")).toContain("water-temperature-hot");
    expect(keys(c, frame(3, 121, { "engine.coolant-temperature": 115 }, true), "EngineMonitor")).toEqual([]);
    expect(keys(c, frame(4, 180, { "engine.coolant-temperature": 90 }), "EngineMonitor")).toContain("water-temperature-clear");
  });

  test("reports stable aero or suspension damage once after three seconds", () => {
    const c = new CrewChiefTriggerCatalog();
    const damage = { "damage.car-damage-front": 0.2, "damage.car-damage-rear": 0.1 };
    c.consume(frame(0, 0, damage));
    expect(keys(c, frame(1, 2.99, damage), "DamageReporting")).toEqual([]);
    expect(keys(c, frame(2, 3, damage), "DamageReporting")).toContain("damage-reported");
    expect(keys(c, frame(3, 4, damage), "DamageReporting")).toEqual([]);
  });

  test("samples rain for ten seconds, emits bucket transitions once, and ignores unchanged readings", () => {
    const c = new CrewChiefTriggerCatalog();
    c.consume(frame(0, 0, { "weather.rain-intensity": 0 }));
    expect(keys(c, frame(1, 9.9, { "weather.rain-intensity": 0.2 }), "ConditionsMonitor")).toEqual([]);
    expect(keys(c, frame(2, 10, { "weather.rain-intensity": 0.2 }), "ConditionsMonitor")).toContain("rain-changed");
    expect(keys(c, frame(3, 20, { "weather.rain-intensity": 0.2 }), "ConditionsMonitor")).toEqual([]);
  });
});
