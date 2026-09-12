import { describe, expect, test } from "bun:test";
import { CREWCHIEF_AUTOMATIC_EVENTS, CREWCHIEF_EVENT_SOURCES } from "../../../shared/telemetry/live/crewchief-callout-contract";
import { CrewChiefTriggerCatalog, CREWCHIEF_TRIGGER_CATALOG } from "../../../server/live-strategy/crewchief-triggers/catalog";
import type { LiveResolvedSemanticFrame } from "../../../server/telemetry/live-projector";
import type { ResolvedValue } from "../../../shared/telemetry/resolver/contracts";

const value = (semanticId: string, current: unknown): ResolvedValue<unknown> => ({ semanticId, value: current, unit: null, mappingStatus: "direct", state: "ok", confidence: 1, freshness: "fresh", confidenceComponents: { semanticFidelity: 1, freshness: 1, inputCompleteness: 1 }, provenance: {} as ResolvedValue<unknown>["provenance"], schemaVersion: "test", limitations: [] });
const frame = (sequence: number, streamId = "stream", values: readonly [string, unknown][] = [
  ["session.session-state", 5], ["timing.lap-number", sequence + 1], ["timing.lap-fraction", sequence / 10],
  ["race.flag-status", "green"], ["race.pit-status", false], ["fuel.fuel-percent", 50],
  ["damage.engine-damage", 0], ["identity.car-left-right", 0],
  ["race.competitor.car-index", [7]],
]): LiveResolvedSemanticFrame => ({ simulator: "acc", sessionId: 1, streamId, sequence, observedAt: { domain: "wall-clock", milliseconds: sequence * 1000 }, ids: values.map(([id]) => id), values: values.map(([id, current]) => value(id, current)) });

describe("CrewChief ACC trigger catalog", () => {
  test("keeps exact 25-family catalog and pinned source", () => {
    expect(CREWCHIEF_TRIGGER_CATALOG.map((item) => item.family)).toEqual([...CREWCHIEF_AUTOMATIC_EVENTS, "Spotter"]);
    expect(CREWCHIEF_TRIGGER_CATALOG).toHaveLength(25);
    expect(CREWCHIEF_TRIGGER_CATALOG.every((item) => item.source.commit === "97dc39c219b94de1099242fb8a5958869083603c")).toBe(true);
    expect(CREWCHIEF_EVENT_SOURCES.Spotter?.[0]?.symbols).toEqual(["trigger"]);
  });

  test("derives capabilities from each descriptor required semantic IDs", () => {
    const capabilities = new CrewChiefTriggerCatalog().capabilities("acc");
    expect(capabilities.ConditionsMonitor.state).toBe("active");
    expect(capabilities.Strategy.state).not.toBe(capabilities.ConditionsMonitor.state);
    expect(capabilities.Strategy.reasonCode).toBeDefined();
    expect(capabilities.Position.reasonCode).toBeDefined();
  });

  test("marks unsupported game capabilities unavailable with explicit reason", () => {
    const capabilities = new CrewChiefTriggerCatalog().capabilities("fm-2023");
    for (const descriptor of CREWCHIEF_TRIGGER_CATALOG) {
      expect(capabilities[descriptor.family]).toEqual({ state: "unavailable", reasonCode: "no-source-backed-semantic-branch" });
    }
  });

  test("does not emit when fresh arrays are value-equal", () => {
    const catalog = new CrewChiefTriggerCatalog();
    catalog.consume(frame(0));
    const events = catalog.consume(frame(1, "stream", [
      ["session.session-state", 5], ["timing.lap-number", 1], ["timing.lap-fraction", 0],
      ["race.flag-status", "green"], ["race.pit-status", false], ["fuel.fuel-percent", 50],
      ["damage.engine-damage", 0], ["identity.car-left-right", 0],
      ["race.competitor.car-index", [7]],
    ])).events;
    expect(events).toHaveLength(0);
  });

  test("owns timeline epoch and increments exactly once per stream change", () => {
    const catalog = new CrewChiefTriggerCatalog();
    expect(catalog.consume(frame(0)).timelineEpoch).toBe(1);
    expect(catalog.consume(frame(1)).timelineEpoch).toBe(1);
    expect(catalog.consume(frame(0, "next")).timelineEpoch).toBe(2);
    expect(catalog.consume(frame(1, "next")).timelineEpoch).toBe(2);
    expect(catalog.consume(frame(2, "next")).timelineEpoch).toBe(2);
  });
});
