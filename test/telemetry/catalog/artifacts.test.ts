import { describe, expect, test } from "bun:test";
import {
  buildTelemetryCatalog,
  buildTelemetryCatalogArtifacts,
  getSourcesWithoutSemanticDefinition,
  getTelemetrySources,
  getTelemetryVariable,
  IRACING_SESSION_INFO_SOURCE_VARIABLES,
  KNOWN_GAME_IDS,
  TELEMETRY_CATALOG,
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
  telemetryCatalogSourceHash,
  assertTelemetryCatalogComplete,
} from "../../support/telemetry/catalog";

describe("semantic telemetry catalog artifacts", () => {
  test("generated artifact is current and structurally complete", async () => {
    expect(JSON.stringify(await buildTelemetryCatalog())).toBe(
      JSON.stringify(TELEMETRY_CATALOG),
    );
    expect(() => assertTelemetryCatalogComplete()).not.toThrow();
  });
  test("rejects unconstrained structured and enum value contracts", () => {
    const structured = getTelemetryVariable("race.competitor.position");
    const structuredSchema = structured.structuredSchema;
    structured.structuredSchema = undefined;
    try {
      expect(() => assertTelemetryCatalogComplete()).toThrow(
        "race.competitor.position has incompatible cardinality or ordering",
      );
    } finally {
      structured.structuredSchema = structuredSchema;
    }

    const enumVariable = getTelemetryVariable("fuel.ers-deploy-mode");
    const enumDomain = enumVariable.enumDomain;
    enumVariable.enumDomain = [];
    try {
      expect(() => assertTelemetryCatalogComplete()).toThrow(
        "fuel.ers-deploy-mode has invalid enum domain",
      );
    } finally {
      enumVariable.enumDomain = enumDomain;
    }
  });
  test("emits deterministic versioned artifacts from one catalog build", async () => {
    expect(TELEMETRY_CATALOG.metadata).toMatchObject({
      catalogVersion: TELEMETRY_CATALOG_VERSION,
      schemaVersion: TELEMETRY_CATALOG_SCHEMA_VERSION,
      contentHash: TELEMETRY_CATALOG_HASH,
      generator: {
        name: "RaceIQ telemetry-catalog generator",
        version: TELEMETRY_CATALOG_VERSION,
      },
    });
    expect(TELEMETRY_CATALOG.metadata.generator.commit).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(TELEMETRY_CATALOG.metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(TELEMETRY_CATALOG.metadata.generatedAt).toBe(
      "1970-01-01T00:00:00.000Z",
    );

    const first = await buildTelemetryCatalogArtifacts();
    const second = await buildTelemetryCatalogArtifacts();
    expect([...second]).toEqual([...first]);
    expect(
      [...first.keys()].map((path) =>
        path.replaceAll("\\", "/").split("/shared/").at(-1),
      ),
    ).toEqual([
      "telemetry/catalog/generated/telemetry-catalog.generated.json",
      "telemetry/catalog/generated/telemetry-catalog.generated.ts",
      "telemetry/catalog/generated/TELEMETRY_CATALOG.md",
      "telemetry/catalog/generated/telemetry-catalog-matrix.md",
    ]);
    expect(
      [...first].find(([path]) =>
        path.endsWith("telemetry-catalog-matrix.md"),
      )?.[1],
    ).toContain("| Semantic ID | Type | Dimensions | Unit | Cardinality |");
  });
  test("normalizes source line endings before provenance hashing", () => {
    const lf = "alpha\nbeta\n";
    expect(telemetryCatalogSourceHash(lf)).toBe(
      telemetryCatalogSourceHash(lf.replaceAll("\n", "\r\n")),
    );
  });
  test("covers every normalized packet field and every parser source inventory", () => {
    expect(TELEMETRY_CATALOG.coverage.normalizedPacketFields).toBe(144);
    expect(TELEMETRY_CATALOG.coverage.semanticVariables).toBe(734);
    expect(TELEMETRY_CATALOG.coverage.sourceCounts).toEqual({
      "fm-2023": {
        total: 95,
        packet: 95,
        extension: 0,
        sdk: 0,
        yaml: 0,
        setup: 0,
        recorded: 95,
      },
      "f1-2025": {
        total: 288,
        packet: 119,
        extension: 169,
        sdk: 0,
        yaml: 0,
        setup: 0,
        recorded: 288,
      },
      acc: {
        total: 200,
        packet: 124,
        extension: 43,
        sdk: 0,
        yaml: 0,
        setup: 33,
        recorded: 167,
      },
      "ac-evo": {
        total: 255,
        packet: 124,
        extension: 95,
        sdk: 0,
        yaml: 0,
        setup: 36,
        recorded: 219,
      },
      iracing: {
        total: 955,
        packet: 119,
        extension: 17,
        sdk: 324,
        yaml: 495,
        setup: 0,
        recorded: 705,
      },
    });

    for (const gameId of KNOWN_GAME_IDS) {
      expect(getSourcesWithoutSemanticDefinition(gameId)).toEqual([]);
      for (const source of getTelemetrySources(gameId)) {
        expect(source.unit.length).toBeGreaterThan(0);
        expect(source.dataType?.length).toBeGreaterThan(0);
        expect(source.description.length).toBeGreaterThan(0);
        expect(source.semanticId.length).toBeGreaterThan(0);
      }
    }
  });
  test("records unit conversions, derived selection, and parser placeholders", () => {
    expect(getTelemetryVariable("motion.velocity-x").canonicalUnit).toBe(
      "m/s",
    );
    expect(
      getTelemetryVariable("tires.wheel-rotation-speed").canonicalUnit,
    ).toBe("rad/s");
    expect(
      getTelemetryVariable("tires.wheel-force.longitudinal").canonicalUnit,
    ).toBe("N");
    expect(getTelemetryVariable("weather.wind-direction")).toMatchObject({
      canonicalUnit: "deg",
      games: { acc: { kind: "direct", nativeUnit: "deg" } },
    });
    expect(getTelemetryVariable("fuel.laps-remaining").canonicalUnit).toBe(
      "count",
    );
    expect(getTelemetryVariable("fuel.remaining-volume").games).toMatchObject({
      "fm-2023": { kind: "unavailable" },
      "f1-2025": { kind: "derived" },
      acc: { kind: "direct", nativeUnit: "L" },
      "ac-evo": { kind: "direct", nativeUnit: "L" },
      iracing: { kind: "direct", nativeUnit: "L" },
    });
    expect(
      Object.values(getTelemetryVariable("fuel.fuel-percent").games).every(
        (mapping) => mapping.kind !== "unavailable",
      ),
    ).toBe(true);

    const currentRaceTime = getTelemetryVariable("timing.current-race-time");
    expect(currentRaceTime.games.acc).toMatchObject({
      kind: "unavailable",
      reason: "parser-placeholder",
    });
    expect(currentRaceTime.games["ac-evo"]).toMatchObject({
      kind: "unavailable",
      reason: "parser-placeholder",
    });
    expect(getTelemetryVariable("aero.drs-active").games.acc).toMatchObject({
      kind: "unavailable",
      reason: "parser-placeholder",
    });
    expect(
      getTelemetryVariable("weather.wind-speed").games["ac-evo"],
    ).toMatchObject({
      kind: "unavailable",
      reason: "parser-placeholder",
    });
    for (const band of ["inner", "middle", "outer"]) {
      expect(
        getTelemetryVariable(`tire.temperature.surface.${band}`).games[
          "ac-evo"
        ],
      ).toMatchObject({
        kind: "unavailable",
        reason: "source-not-populated",
      });
    }
    expect(
      getTelemetryVariable("identity.drivetrain-type").games,
    ).toMatchObject({
      "f1-2025": { kind: "unavailable", reason: "parser-placeholder" },
      acc: { kind: "unavailable", reason: "parser-placeholder" },
      "ac-evo": { kind: "unavailable", reason: "parser-placeholder" },
      iracing: { kind: "unavailable", reason: "parser-placeholder" },
    });
    expect(getTelemetryVariable("race.is-race-on").games).toMatchObject({
      "f1-2025": { kind: "unavailable", reason: "parser-placeholder" },
      iracing: {
        kind: "normalized",
        sources: ["iRacing.IsOnTrack"],
      },
    });
    expect(getTelemetryVariable("tires.tire-pressure").games.iracing).toMatchObject({
      kind: "normalized",
      nativeUnit: "kPa",
      sources: {
        FL: ["iRacing.LFcoldPressure"],
        FR: ["iRacing.RFcoldPressure"],
        RL: ["iRacing.LRcoldPressure"],
        RR: ["iRacing.RRcoldPressure"],
      },
    });

    expect(getTelemetryVariable("session.session-type").games.iracing.kind).toBe(
      "normalized",
    );
    expect(getTelemetryVariable("timing.total-laps").games.iracing.kind).toBe(
      "normalized",
    );
    expect(
      getTelemetrySources("fm-2023").find(
        (source) => source.path === "TelemetryPacket.TireTempFL",
      ),
    ).toMatchObject({ unit: "°F" });
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (source) => source.path === "SessionInfo.WeekendInfo.TrackDirection",
      ),
    ).toMatchObject({
      unit: "text",
      semanticId: "identity.track.direction",
    });
  });
  test("every semantic value has unit, description, and mapping for every game", () => {
    for (const variable of TELEMETRY_CATALOG.variables) {
      expect(variable.canonicalUnit.length).toBeGreaterThan(0);
      expect(variable.description.length).toBeGreaterThan(0);
      expect(Object.keys(variable.games).sort()).toEqual(
        [...KNOWN_GAME_IDS].sort(),
      );
    }
  });
});
