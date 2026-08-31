import { describe, expect, test } from "bun:test";
import { CrewChiefTriggerCatalog } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

const value = (semanticId: string, current: unknown): ResolvedValue<unknown> => ({ semanticId, value: current, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 }, provenance: {} as ResolvedValue<unknown>["provenance"], schemaVersion: "test", limitations: [] });
const frame = (sequence: number, observedAt: number, changes: Record<string, unknown> = {}, streamId = "strategy"): LiveResolvedSemanticFrame => {
  const entries: readonly [string, unknown][] = [
    ["session.session-state", 5], ["race.pit-status", "out"], ["race.flag-status", "green"],
    ["fuel.remaining-volume", 50], ["fuel.fuel-per-lap", 10], ["race.penalties", 0], ["engine.battery-state-of-charge", 0.8], ["race.player.push-to-pass-active", false], ["aero.drs-active", false], ...Object.entries(changes),
  ];
  return { simulator: "acc", sessionId: 1, streamId, sequence, observedAt: { domain: "wall-clock", milliseconds: observedAt }, ids: entries.map(([id]) => id), values: entries.map(([id, current]) => value(id, current)) };
};
const keys = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame) => catalog.consume(source).events.map((event) => event.eventKey);
const familyKeys = (catalog: CrewChiefTriggerCatalog, source: LiveResolvedSemanticFrame, family: string) =>
  catalog.consume(source).events.filter((event) => event.family === family).map((event) => event.eventKey);

 describe("CrewChief ACC race-control and strategy triggers", () => {
  test("penalty count increase emits one penalty-issued", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    expect(keys(catalog, frame(1, 1000, { "race.penalties": 1 }))).toEqual(["penalty-issued"]);
    expect(keys(catalog, frame(2, 2000, { "race.penalties": 1 }))).toEqual([]);
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

  test("ACC keeps unsupported battery, strategy, push-now, and overtaking aids silent with explicit capability reasons", () => {
    const catalog = new CrewChiefTriggerCatalog();
    keys(catalog, frame(0, 0));
    const changed = catalog.consume(frame(1, 1000, { "engine.battery-state-of-charge": 0.1, "race.pit-status": "pit_lane", "race.player.push-to-pass-active": true, "aero.drs-active": true }));
    expect(changed.events.filter((event) => ["Battery", "Strategy", "PushNow", "OvertakingAidsMonitor"].includes(event.family))).toEqual([]);
    const capabilities = catalog.capabilities("acc");
    for (const family of ["Battery", "Strategy", "PushNow", "OvertakingAidsMonitor"] as const) {
      expect(capabilities[family].state).toBe("unavailable");
      expect(capabilities[family].reasonCode).toBe("no-source-backed-semantic-branch");
    }
  });
});
