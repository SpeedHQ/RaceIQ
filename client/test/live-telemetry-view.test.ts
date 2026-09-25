import { describe, expect, it } from "bun:test";
import type { GameId } from "../../shared/games/ids";
import type { LiveTelemetryFrameMessageV1, LiveTelemetrySchemaMessageV1 } from "../../shared/telemetry/live/contracts";
import { liveSemanticIds } from "../../shared/telemetry/live/semantics";
import { buildLiveTelemetryView, indexTelemetrySchema, normalizeAccCompetitors, readIndexedValue } from "../src/lib/live-telemetry-view";

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
    definitions: semanticIds.map((semanticId) => ({ semanticId, unit: units[semanticId] ?? (semanticId.startsWith("tire.temperature.") ? "°C" : null), mappingStatus: "direct", schemaVersion: "1", limitations: [] })),
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
  it("projects LMU catalog and native identities without using sentinel ordinals", () => {
    const definition = schema([...liveSemanticIds("lmu")], "lmu");
    for (const [carId, trackId] of [
      ["ferrari_499p_2023", "spa_2023/spawec"],
      ["Custom / Car %2F #7", "Unlisted / Layout %2F"],
    ]) {
      const values: Record<string, unknown> = {
        "identity.car-id": carId,
        "identity.track-id": trackId,
        "identity.car-ordinal": -1,
        "identity.track-ordinal": -1,
        "motion.speed": 42,
      };
      const view = buildLiveTelemetryView(definition, frame(
        definition.definitions.map(({ semanticId }) => values[semanticId] ?? null),
        { schemaId: definition.schemaId },
      ))!;
      expect(view.identity.carId).toBe(carId);
      expect(view.identity.trackId).toBe(trackId);
      expect(view.motion.speedMps).toBe(42);
    }
  });

  it("withholds unavailable LMU identity rather than falling back to -1", () => {
    const definition = schema(["identity.car-id", "identity.track-id", "identity.car-ordinal", "identity.track-ordinal"], "lmu");
    const view = buildLiveTelemetryView(definition, frame(
      ["ferrari_499p_2023", "spa_2023/spawec", -1, -1],
      { schemaId: definition.schemaId, states: { 0: "missing" }, freshness: { 1: "stale" } },
    ))!;
    expect(view.identity.carId).toBeUndefined();
    expect(view.identity.trackId).toBeUndefined();
    expect(view.statusBySemanticId["identity.car-id"]).toEqual({ resolution: "missing", freshness: "fresh" });
    expect(view.statusBySemanticId["identity.track-id"]).toEqual({ resolution: "ok", freshness: "stale" });
  });

  it("preserves numeric identities and existing ordinal consumers for other games", () => {
    const definition = schema(["identity.car-ordinal", "identity.track-ordinal", "identity.car-class"]);
    const view = buildLiveTelemetryView(definition, frame([42, 7, 3]))!;
    expect(view.identity).toMatchObject({ carId: 42, trackId: 7, carOrdinal: 42, trackOrdinal: 7, carClass: 3 });
  });

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

  it("accepts canonical Celsius and rejects noncanonical temperature units", () => {
    const semanticIds = ["tire.temperature.surface.representative"];
    const forzaSchema = schema(semanticIds, "fm-2023", { "tire.temperature.surface.representative": "°F" });
    const accSchema = schema(semanticIds, "acc", { "tire.temperature.surface.representative": "°C" });
    const forza = buildLiveTelemetryView(forzaSchema, frame([[212, 32, 68, 86]], { schemaId: "schema-fm-2023" }))!;
    const acc = buildLiveTelemetryView(accSchema, frame([[100, 0, 20, 30]]))!;

    expect(forza.tires.surfaceTemperatureC).toBeUndefined();
    expect(acc.tires.surfaceTemperatureC).toEqual({
      fl: { representative: 100 },
      fr: { representative: 0 },
      rl: { representative: 20 },
      rr: { representative: 30 },
    });
  });

  it("keeps F1 surface and core channels independent", () => {
    const definition = schema([
      "tire.temperature.surface.representative",
      "tire.temperature.core",
    ], "f1-2025");
    const value = buildLiveTelemetryView(
      definition,
      frame([
        [48, 49, 56, 57],
        [78, 79, 84, 85],
      ], { schemaId: "schema-f1-2025" }),
    )!;

    expect(value.tires.surfaceTemperatureC).toEqual({
      fl: { representative: 48 },
      fr: { representative: 49 },
      rl: { representative: 56 },
      rr: { representative: 57 },
    });
    expect(value.tires.coreTemperatureC).toEqual({
      fl: 78,
      fr: 79,
      rl: 84,
      rr: 85,
    });
    expect(value.tires.carcassTemperatureC).toBeUndefined();
  });

  it("preserves each available surface band by name", () => {
    const semanticIds = [
      "tire.temperature.surface.representative",
      "tire.temperature.surface.inner",
      "tire.temperature.surface.middle",
      "tire.temperature.surface.outer",
    ];
    const definition = schema(semanticIds, "acc");
    const value = buildLiveTelemetryView(
      definition,
      frame([
        [80, 81, 82, 83],
        [84, 85, 86, 87],
        [79, 80, 81, 82],
        [76, 77, 78, 79],
      ]),
    )!;

    expect(value.tires.surfaceTemperatureC).toEqual({
      fl: { representative: 80, inner: 84, middle: 79, outer: 76 },
      fr: { representative: 81, inner: 85, middle: 80, outer: 77 },
      rl: { representative: 82, inner: 86, middle: 81, outer: 78 },
      rr: { representative: 83, inner: 87, middle: 82, outer: 79 },
    });
  });

  it("preserves iRacing carcass bands without averaging them", () => {
    const definition = schema([
      "tire.temperature.carcass.left",
      "tire.temperature.carcass.middle",
      "tire.temperature.carcass.right",
    ], "iracing");
    const value = buildLiveTelemetryView(
      definition,
      frame([
        [70, 71, 72, 73],
        [80, 81, 82, 83],
        [90, 91, 92, 93],
      ], { schemaId: "schema-iracing" }),
    )!;

    expect(value.tires.carcassTemperatureC).toEqual({
      fl: { left: 70, middle: 80, right: 90 },
      fr: { left: 71, middle: 81, right: 91 },
      rl: { left: 72, middle: 82, right: 92 },
      rr: { left: 73, middle: 83, right: 93 },
    });
    expect(value.tires.coreTemperatureC).toBeUndefined();
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

  it("projects player pit status and simulator compound names", () => {
    const definition = schema(["race.pit-status", "tires.tire-compound-name"], "acc");
    const value = buildLiveTelemetryView(definition, frame(["in_pit", "soft"]))!;

    expect(value.race.pitStatus).toBe("in_pit");
    expect(value.tires.compound).toBe("soft");
  });

  it("normalizes iRacing pit-road state and selects the F1 player competitor", () => {
    const iracingSchema = schema(["race.on-pit-road"], "iracing");
    const iracing = buildLiveTelemetryView(iracingSchema, frame([true], { schemaId: "schema-iracing" }))!;
    const f1Schema = schema(["race.race-position", "race.competitor.position", "race.competitor.pit-status"], "f1-2025");
    const f1 = buildLiveTelemetryView(f1Schema, frame([3, [1, 3], [0, 2]], { schemaId: "schema-f1-2025" }))!;

    expect(iracing.race.pitStatus).toBe("pit_lane");
    expect(f1.race.pitStatus).toBe(2);
  });
});

describe("ACC opponent normalization", () => {
  function capturedGrid() {
    const values: Record<string, unknown> = {
      "identity.player-car-index": 42,
      "race.competitor.car-index": [7, 42],
      "race.competitor.driver-name": ["Leader", "Player"],
      "race.competitor.car-class-id": ["0", "0"],
      "race.competitor.car-class-name": ["GT3", "GT3"],
      "race.competitor.position": [1, 2],
      "race.competitor.laps-complete": [5, 5],
      "race.competitor.pit-status": ["out", "pit_lane"],
      "race.competitor.connected": [true, false],
      "timing.competitor.last-lap-time": [90.123, 91.456],
      "timing.competitor.last-lap-valid": [true, false],
    };
    return {
      values,
      states: Object.fromEntries(Object.keys(values).map((id) => [id, "ok" as const])) as Record<string, "ok" | "missing">,
      freshness: Object.fromEntries(Object.keys(values).map((id) => [id, "fresh" as const])) as Record<string, "fresh" | "stale">,
      opponentSource: { source: "acc-broadcast", state: "available", reasonCode: "ready" } as const,
    };
  }

  it("normalizes live and retained replay evidence identically without inferring player from position", () => {
    const captured = capturedGrid();
    const ids = Object.keys(captured.values);
    const live = frame(ids.map((id) => captured.values[id]));
    live.context.opponentSource = captured.opponentSource;
    const view = buildLiveTelemetryView(schema(ids), live)!;
    expect(view.competitors).toEqual(normalizeAccCompetitors(captured));
    expect(view.identity.playerCarIndex).toBe(42);
    expect(view.competitors[1]).toMatchObject({ carIndex: 42, position: 2, connected: false, pitStatus: "pit_lane", lastLapS: 91.456, lastLapValid: false });
  });

  it("replaces previously available live rows with source-loss status", () => {
    const captured = capturedGrid();
    const ids = Object.keys(captured.values);
    const live = frame(ids.map((id) => captured.values[id]));
    for (const state of ["unavailable", "stale", "malformed"] as const) {
      live.context.opponentSource = { ...captured.opponentSource, state, reasonCode: "source-timeout" };
      const view = buildLiveTelemetryView(schema(ids), live)!;
      expect(view.competitors).toEqual([]);
      expect(view.opponentSource?.state).toBe(state);
      expect(view.identity.playerCarIndex).toBe(42);
    }
  });

  it("withholds entire grid for stale, unresolved, or absent retained quality", () => {
    const captured = capturedGrid();
    captured.freshness["race.competitor.position"] = "stale";
    expect(normalizeAccCompetitors(captured)).toEqual([]);
    captured.freshness["race.competitor.position"] = "fresh";
    captured.states["race.competitor.driver-name"] = "missing";
    expect(normalizeAccCompetitors(captured)).toEqual([]);
    delete captured.states["race.competitor.driver-name"];
    expect(normalizeAccCompetitors(captured)).toEqual([]);
  });

  it("rejects misaligned arrays, duplicate indexes, missing player, and malformed elements", () => {
    for (const [id, value] of [
      ["race.competitor.position", [1]],
      ["race.competitor.car-index", [42, 42]],
      ["race.competitor.car-index", [7, Number.NaN]],
      ["identity.player-car-index", 99],
      ["identity.player-car-index", undefined],
      ["race.competitor.connected", [true, 1]],
      ["race.competitor.driver-name", ["Leader", null]],
      ["timing.competitor.last-lap-time", [90, Number.POSITIVE_INFINITY]],
    ] as const) {
      const captured = capturedGrid();
      captured.values[id] = value;
      expect(normalizeAccCompetitors(captured)).toEqual([]);
    }
  });

  it("accepts bounded complete grids but rejects empty or oversized grids", () => {
    for (const count of [0, 64, 65]) {
      const captured = capturedGrid();
      for (const [id, value] of Object.entries(captured.values)) {
        if (Array.isArray(value)) captured.values[id] = Array.from({ length: count }, (_, index) => id === "race.competitor.car-index" ? index : value[0]);
      }
      captured.values["identity.player-car-index"] = 42;
      expect(normalizeAccCompetitors(captured).length).toBe(count === 64 ? 64 : 0);
    }
  });
});
