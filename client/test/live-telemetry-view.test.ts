import { describe, expect, it } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import { buildLiveTelemetryView, indexTelemetrySchema, readIndexedValue } from "../src/lib/live-telemetry-view";

function schema(semanticIds: string[], simulator: GameId = "acc", units: Readonly<Record<string, string | null>> = {}): LiveTelemetrySchemaMessageV1 {
  return {
    type: "telemetry-schema",
    protocolVersion: 1,
    schemaId: `schema-${simulator}`,
    simulator,
    catalogVersion: "catalog",
    catalogHash: "hash",
    catalogSchemaVersion: "1",
    parserVersion: "parser",
    resolverVersion: "resolver",
    derivationVersion: "derivation",
    definitions: semanticIds.map((semanticId) => ({ semanticId, unit: units[semanticId] ?? null, mappingStatus: "direct", schemaVersion: "1", limitations: [] })),
  };
}

function frame(
  values: unknown[],
  options: {
    schemaId?: string;
    states?: LiveTelemetryFrameMessageV1["states"];
    freshness?: LiveTelemetryFrameMessageV1["freshness"];
  } = {},
): LiveTelemetryFrameMessageV1 {
  return {
    type: "telemetry-frame",
    protocolVersion: 1,
    schemaId: options.schemaId ?? "schema-acc",
    streamId: "stream",
    sessionId: null,
    sequence: 1,
    observedAt: { domain: "session", milliseconds: 2 },
    receivedAtMs: 3,
    values: values as never[],
    states: options.states,
    freshness: options.freshness,
    context: {},
  };
}

describe("live telemetry view", () => {
  it("indexes semantic values and rejects schema mismatch", () => {
    const definition = schema(["motion.speed"]);
    const indexed = indexTelemetrySchema(definition);
    expect(readIndexedValue(indexed, frame([4]), "motion.speed")).toBe(4);
    expect(buildLiveTelemetryView(definition, frame([4], { schemaId: "other" }))).toBeUndefined();
  });

  it("preserves resolution and freshness while withholding non-fresh values", () => {
    const definition = schema(["motion.speed", "tires.tire-pressure", "timing.lap-fraction"]);
    const value = buildLiveTelemetryView(
      definition,
      frame([4, [1, 2, 3, 4], 0.5], {
        states: { 1: "missing" },
        freshness: { 2: "stale" },
      }),
    )!;

    expect(value.motion.speedMps).toBe(4);
    expect(value.tires.pressurePsi).toBeUndefined();
    expect(value.timing.lapFraction).toBeUndefined();
    expect(value.statusBySemanticId["tires.tire-pressure"]).toEqual({ resolution: "missing", freshness: "fresh" });
    expect(value.statusBySemanticId["timing.lap-fraction"]).toEqual({ resolution: "ok", freshness: "stale" });
  });

  it("does not coerce incomplete vectors to zero", () => {
    const definition = schema(["motion.position-x", "motion.position-z"]);
    const incomplete = buildLiveTelemetryView(definition, frame([12, null]))!;
    const legitimateZero = buildLiveTelemetryView(definition, frame([0, 0]))!;

    expect(incomplete.motion.position).toBeUndefined();
    expect(legitimateZero.motion.position).toEqual({ x: 0, z: 0 });
  });

  it("normalizes simulator tire temperature units to explicit Celsius", () => {
    const semanticIds = ["tire.temperature.average"];
    const forzaSchema = schema(semanticIds, "fm-2023", { "tire.temperature.average": "°F" });
    const accSchema = schema(semanticIds, "acc", { "tire.temperature.average": "°C" });
    const forza = buildLiveTelemetryView(forzaSchema, frame([[212, 32, 68, 86]], { schemaId: "schema-fm-2023" }))!;
    const acc = buildLiveTelemetryView(accSchema, frame([[100, 0, 20, 30]]))!;

    expect(forza.tires.temperatureC).toEqual({ fl: 100, fr: 0, rl: 20, rr: 30 });
    expect(acc.tires.temperatureC).toEqual({ fl: 100, fr: 0, rl: 20, rr: 30 });
  });

  it("projects game features through canonical groups without simulator branches", () => {
    const definition = schema(["aero.drs-active", "fuel.ers-store-energy", "weather.rain-percent", "damage.front-left-wing-damage", "session.session-type"], "f1-2025");
    const value = buildLiveTelemetryView(definition, frame([true, 2_000_000, 25, 0, "race"], { schemaId: "schema-f1-2025" }))!;

    expect(value.simulator).toBe("f1-2025");
    expect(value.aero.drsActive).toBe(true);
    expect(value.ers.storeJ).toBe(2_000_000);
    expect(value.weather.rainPercent).toBe(25);
    expect(value.damage.frontLeftWingPct).toBe(0);
    expect(value.session.type).toBe("race");
  });
});
