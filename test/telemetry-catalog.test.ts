import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  assertDirectToSimplifiedCompatibilityReviews,
  buildTelemetryCatalog,
  buildTelemetryCatalogArtifacts,
  telemetryCatalogSourceHash,
} from "../scripts/generate-telemetry-catalog";
import { collectIRacingSessionInfoLeafPaths } from "../scripts/iracing-session-info-capture";
import {
  TELEMETRY_CATALOG,
  TELEMETRY_CATALOG_HASH,
  TELEMETRY_CATALOG_SCHEMA_VERSION,
  TELEMETRY_CATALOG_VERSION,
} from "../shared/telemetry/catalog/data";
import {
  getSourcesWithoutSemanticDefinition,
  getTelemetryChildren,
  getTelemetrySources,
  getTelemetryVariable,
  IRACING_SESSION_INFO_SOURCE_VARIABLES,
  IRACING_TELEMETRY_SOURCE_VARIABLES,
  isTelemetryEnumValue,
} from "../shared/telemetry/catalog/query";
import { assertTelemetryCatalogComplete } from "../shared/telemetry/catalog/validation";
import { KNOWN_GAME_IDS } from "../shared/games/ids";

describe("semantic telemetry catalog", () => {
  test("generated artifact is current and structurally complete", async () => {
    expect(JSON.stringify(await buildTelemetryCatalog())).toBe(
      JSON.stringify(TELEMETRY_CATALOG),
    );
    expect(() => assertTelemetryCatalogComplete()).not.toThrow();
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

  test("enforces resolver-ready value and mapping compatibility contracts", () => {
    for (const variable of TELEMETRY_CATALOG.variables) {
      expect(variable.valueType).toMatch(
        /^(number|boolean|string|enum|structured)$/,
      );
      expect(variable.dimensions.length).toBeGreaterThan(0);
      expect(variable.cardinality).toBeDefined();
      expect(Array.isArray(variable.limitations)).toBe(true);
      if (variable.shape === "per-wheel") {
        expect(variable.cardinality).toEqual({ kind: "fixed", count: 4 });
        expect(variable.ordering).toEqual(["FL", "FR", "RL", "RR"]);
      }
      if (variable.shape === "vector") {
        expect(variable.cardinality).toEqual({ kind: "fixed", count: 3 });
        expect(variable.ordering).toEqual(["x", "y", "z"]);
      }
      if (variable.shape === "array") {
        expect(variable.cardinality.kind).toBe("variable");
        expect(variable.ordering).toEqual(["source-order"]);
      }
      if (variable.shape === "structured") {
        expect(variable.valueType).toBe("structured");
        expect(variable.ordering?.length).toBeGreaterThan(0);
        expect(variable.structuredSchema?.indices.length).toBeGreaterThan(0);
        expect(variable.structuredSchema?.fields.length).toBeGreaterThan(0);
        expect(variable.structuredSchema?.indices[0].cardinality).toEqual(
          variable.cardinality,
        );
      } else {
        expect(variable.structuredSchema).toBeUndefined();
      }
      if (variable.valueType === "enum") {
        expect(variable.enumDomain?.length).toBeGreaterThan(0);
        for (const value of variable.enumDomain ?? []) {
          expect(value.trim()).not.toBe("");
          expect(value).not.toBe("*");
          expect(isTelemetryEnumValue(variable.id, value)).toBe(true);
        }
        expect(isTelemetryEnumValue(variable.id, "__outside-domain__")).toBe(
          false,
        );
      } else {
        expect(variable.enumDomain).toBeUndefined();
      }

      for (const mapping of Object.values(variable.games)) {
        if (mapping.kind === "unavailable") continue;
        expect(mapping.provenance.artifact.length).toBeGreaterThan(0);
        expect(mapping.provenance.commit).toMatch(/^[a-f0-9]{64}$/);
        expect(Array.isArray(mapping.limitations)).toBe(true);
        if (mapping.kind === "direct") {
          expect(mapping.nativeUnit).toBe(variable.canonicalUnit);
          expect(mapping.execution).toBeUndefined();
          continue;
        }
        expect(mapping.normalization?.length).toBeGreaterThan(0);
        expect(mapping.execution).toMatchObject({
          deterministic: true,
          version: TELEMETRY_CATALOG_VERSION,
        });
        expect(mapping.execution?.declaredInputs.length).toBeGreaterThan(0);
        expect(mapping.execution?.codeHash).toMatch(/^[a-f0-9]{64}$/);
        if (mapping.kind === "normalized") {
          expect(mapping.execution?.kind).toBe("conversion");
        }
        if (mapping.kind === "derived") {
          expect(mapping.execution?.kind).toBe("derivation");
        }
        if (mapping.kind === "simplified") {
          expect(mapping.execution?.kind).toBe("simplification");
          expect(mapping.limitations.length).toBeGreaterThan(0);
        }
      }
    }
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

  test("requires review only when a mapping loses direct fidelity", () => {
    const catalog = (kind: "direct" | "simplified", review?: unknown) => ({
      variables: [
        {
          id: "motion.speed",
          games: Object.fromEntries([
            ...KNOWN_GAME_IDS.map((gameId) => [
              gameId,
              { kind: "unavailable" },
            ]),
            [
              "fm-2023",
              {
                kind,
                ...(review === undefined
                  ? {}
                  : { compatibilityReview: review }),
              },
            ],
          ]),
        },
      ],
    });

    expect(() =>
      assertDirectToSimplifiedCompatibilityReviews(
        catalog("direct"),
        catalog("direct"),
      ),
    ).not.toThrow();
    expect(() =>
      assertDirectToSimplifiedCompatibilityReviews(
        catalog("simplified"),
        catalog("simplified"),
      ),
    ).not.toThrow();
    expect(() =>
      assertDirectToSimplifiedCompatibilityReviews(
        catalog("simplified"),
        catalog("direct"),
      ),
    ).toThrow(
      "Direct-to-simplified telemetry mappings require explicit compatibilityReview",
    );
    expect(() =>
      assertDirectToSimplifiedCompatibilityReviews(
        catalog("simplified", {
          id: "CATALOG-205",
          rationale:
            "Source detail is intentionally reduced to the common semantic.",
        }),
        catalog("direct"),
      ),
    ).not.toThrow();
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
        total: 285,
        packet: 119,
        extension: 166,
        sdk: 0,
        yaml: 0,
        setup: 0,
        recorded: 285,
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

  test("organizes tire temperature as one detailed-to-simple hierarchy", () => {
    expect(
      getTelemetryChildren("tire.temperature").map((node) => node.label),
    ).toEqual([
      "Representative / average",
      "Carcass temperature",
      "Surface temperature",
    ]);
    expect(
      getTelemetryChildren("tire.temperature.carcass").map(
        (node) => node.label,
      ),
    ).toEqual([
      "Average carcass temperature",
      "Left carcass temperature",
      "Middle carcass temperature",
      "Right carcass temperature",
    ]);
    expect(
      getTelemetryChildren("tire.temperature.surface").map(
        (node) => node.label,
      ),
    ).toEqual([
      "Inner surface temperature",
      "Middle surface temperature",
      "Outer surface temperature",
    ]);
  });

  test("defines common average as normalized where needed and simplified for iRacing", () => {
    const average = getTelemetryVariable("tire.temperature.average");

    expect(average.canonicalUnit).toBe("°C");
    expect(average.games["fm-2023"]).toMatchObject({
      kind: "normalized",
      nativeUnit: "°F",
      normalization: "(fahrenheit - 32) * 5 / 9",
    });
    expect(average.games["f1-2025"].kind).toBe("direct");
    expect(average.games.acc.kind).toBe("direct");
    expect(average.games["ac-evo"].kind).toBe("direct");
    expect(average.games.iracing).toMatchObject({
      kind: "simplified",
      nativeUnit: "°C",
      freshness: "pit-snapshot",
    });

    const iracing = average.games.iracing;
    if (iracing.kind === "unavailable") throw new Error("mapping missing");
    expect(iracing.sources).toEqual({
      FL: ["iRacing.LFtempCL", "iRacing.LFtempCM", "iRacing.LFtempCR"],
      FR: ["iRacing.RFtempCL", "iRacing.RFtempCM", "iRacing.RFtempCR"],
      RL: ["iRacing.LRtempCL", "iRacing.LRtempCM", "iRacing.LRtempCR"],
      RR: ["iRacing.RRtempCL", "iRacing.RRtempCM", "iRacing.RRtempCR"],
    });
    expect(iracing.normalization).toBe(
      "average available left, middle, and right carcass temperatures per tire",
    );

    expect(
      getTelemetryVariable("tire.temperature.carcass.average").games.iracing,
    ).toMatchObject({
      kind: "simplified",
      freshness: "pit-snapshot",
    });
  });

  test("keeps detailed iRacing carcass bands as direct variables", () => {
    for (const band of ["left", "middle", "right"] as const) {
      const variable = getTelemetryVariable(
        `tire.temperature.carcass.${band}`,
      );
      expect(variable.games.iracing.kind).toBe("direct");
      expect(variable.canonicalUnit).toBe("°C");
    }
  });

  test("links all 324 captured iRacing SDK variables with source metadata", () => {
    expect(IRACING_TELEMETRY_SOURCE_VARIABLES).toHaveLength(324);
    expect(
      IRACING_TELEMETRY_SOURCE_VARIABLES.filter(
        (variable) => variable.recordedByRaceIQ,
      ),
    ).toHaveLength(74);

    expect(
      IRACING_TELEMETRY_SOURCE_VARIABLES.find(
        (variable) => variable.path === "LFtempCL",
      ),
    ).toMatchObject({
      unit: "C",
      dataType: "float",
      count: 1,
      description: "LF tire left carcass temperature",
      recordedByRaceIQ: true,
      semanticId: "tire.temperature.carcass.left",
    });
    expect(
      IRACING_TELEMETRY_SOURCE_VARIABLES.find(
        (variable) => variable.path === "AirDensity",
      ),
    ).toMatchObject({
      unit: "kg/m^3",
      dataType: "float",
      count: 1,
      recordedByRaceIQ: false,
    });
    expect(
      IRACING_TELEMETRY_SOURCE_VARIABLES.find(
        (variable) => variable.path === "CarIdxLapDistPct",
      ),
    ).toMatchObject({
      unit: "%",
      dataType: "float",
      count: 64,
      semanticId: "timing.competitor.lap-fraction",
    });
  });

  test("catalogues iRacing SessionInfo YAML as exact v3 recording sources", () => {
    expect(IRACING_SESSION_INFO_SOURCE_VARIABLES).toHaveLength(495);
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.filter(
        (variable) => variable.retention === "exact",
      ),
    ).toHaveLength(IRACING_SESSION_INFO_SOURCE_VARIABLES.length);
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.filter(
        (variable) => variable.recordedByRaceIQ,
      ),
    ).toHaveLength(IRACING_SESSION_INFO_SOURCE_VARIABLES.length);
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.filter(
        (variable) =>
          variable.retention === "normalized" ||
          variable.retention === "not-recorded",
      ),
    ).toEqual([]);

    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (variable) => variable.path === "SessionInfo",
      ),
    ).toMatchObject({
      unit: "structured",
      dataType: "string",
      retention: "exact",
      recordedByRaceIQ: true,
      semanticId: "diagnostics.raw-session-metadata",
    });

    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (variable) =>
          variable.path ===
          "SessionInfo.SplitTimeInfo.Sectors[].SectorStartPct",
      ),
    ).toMatchObject({
      unit: "fraction",
      retention: "exact",
      recordedByRaceIQ: true,
      semanticId: "timing.sector.layout.start-fractions",
    });
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (variable) =>
          variable.path ===
          "SessionInfo.SessionInfo.Sessions[].ResultsPositions[].FastestTime",
      ),
    ).toMatchObject({
      unit: "s",
      retention: "exact",
      recordedByRaceIQ: true,
      semanticId: "timing.competitor.best-lap-time",
    });
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (variable) =>
          variable.path === "SessionInfo.WeekendInfo.TrackLengthOfficial",
      ),
    ).toMatchObject({
      unit: "value-with-unit",
      retention: "exact",
      recordedByRaceIQ: true,
      semanticId: "timing.official-track-length",
    });
    expect(getTelemetryVariable("timing.official-track-length")).toMatchObject({
      canonicalUnit: "m",
      games: {
        iracing: {
          kind: "normalized",
          normalization: "parse YAML value-with-unit as m",
        },
      },
    });
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (variable) => variable.path === "SessionInfo.CarSetup.**",
      ),
    ).toMatchObject({
      unit: "structured",
      retention: "exact",
      recordedByRaceIQ: true,
      semanticId: "setup.metadata.unmapped-source-values",
    });
  });

  test("normalizes captured YAML array leaves and covers dynamic setup paths", () => {
    const capturedLeaves = collectIRacingSessionInfoLeafPaths(`
WeekendInfo:
  TrackID: 99
SessionInfo:
  Sessions:
  - SessionNum: 0
    ResultsPositions:
    - CarIdx: 7
      FastestTime: 121.25
CarSetup:
  Chassis:
    Front:
      ArbDiameter: 35.0 mm
    BuildSpecific:
      NewAdjustment: 4 clicks
`);

    expect(capturedLeaves).toEqual([
      "CarSetup.Chassis.BuildSpecific.NewAdjustment",
      "CarSetup.Chassis.Front.ArbDiameter",
      "SessionInfo.Sessions[].ResultsPositions[].CarIdx",
      "SessionInfo.Sessions[].ResultsPositions[].FastestTime",
      "SessionInfo.Sessions[].SessionNum",
      "WeekendInfo.TrackID",
    ]);

    const catalogPaths = new Set(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.map((source) =>
        source.path.replace(/^SessionInfo\./, ""),
      ),
    );
    const wildcards = [...catalogPaths]
      .filter((path) => path.endsWith(".**"))
      .map((path) => path.slice(0, -2));
    const uncovered = capturedLeaves.filter(
      (path) =>
        !catalogPaths.has(path) &&
        !wildcards.some((prefix) => path.startsWith(prefix)),
    );

    expect(uncovered).toEqual([]);
    expect(catalogPaths.has("CarSetup.Chassis.Front.ArbDiameter")).toBe(true);
    expect(
      catalogPaths.has("CarSetup.Chassis.BuildSpecific.NewAdjustment"),
    ).toBe(false);
    expect(
      wildcards.some((prefix) =>
        "CarSetup.Chassis.BuildSpecific.NewAdjustment".startsWith(prefix),
      ),
    ).toBe(true);
  });

  test("represents every committed capture-derived SessionInfo leaf", () => {
    const manifest = JSON.parse(
      readFileSync(
        "data/diagnostics/iracing-session-info/racinginsights-v1-6d9873a-paths.json",
        "utf8",
      ),
    ) as {
      format: string;
      source: {
        url: string;
        commit: string;
        license: string;
      };
      leafPaths: string[];
    };
    expect(manifest.format).toBe(
      "raceiq-iracing-session-info-paths-v1",
    );
    expect(manifest.source.url).toMatch(/^https:\/\//);
    expect(manifest.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(manifest.source.license.length).toBeGreaterThan(0);
    expect(manifest.leafPaths).toEqual(
      [...new Set(manifest.leafPaths)].sort(),
    );

    const catalogPaths = new Set(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.map((source) =>
        source.path.replace(/^SessionInfo\./, ""),
      ),
    );
    expect(
      manifest.leafPaths.filter((path) => !catalogPaths.has(path)),
    ).toEqual([]);
  });

  test("maps stable iRacing setup leaves before one narrow fallback", () => {
    const setupSources = IRACING_SESSION_INFO_SOURCE_VARIABLES.filter(
      (source) => source.path.startsWith("SessionInfo.CarSetup."),
    );
    expect(setupSources).toHaveLength(278);
    expect(
      setupSources.filter((source) => source.path.includes("**")),
    ).toHaveLength(1);

    expect(
      setupSources.find(
        (source) =>
          source.path === "SessionInfo.CarSetup.Chassis.LeftFront.Camber",
      ),
    ).toMatchObject({
      unit: "value-with-unit",
      semanticId: "setup.alignment.camber",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.TiresAero.RightRear.StartingPressure",
      ),
    ).toMatchObject({
      semanticId: "setup.tires.starting-pressure",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.Chassis.BrakesInCar.AbsSetting",
      ),
    ).toMatchObject({
      unit: "level",
      semanticId: "setup.electronics.abs",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.Chassis.Front.EnduranceLights",
      ),
    ).toMatchObject({
      unit: "configuration",
      semanticId: "setup.electronics.endurance-lights",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.Chassis.Front.LeftSideLedStrips",
      ),
    ).toMatchObject({
      semanticId: "setup.electronics.left-side-led-strips",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.Chassis.Front.RightSideLedStrips",
      ),
    ).toMatchObject({
      semanticId: "setup.electronics.right-side-led-strips",
    });
    expect(
      setupSources.find(
        (source) =>
          source.path ===
          "SessionInfo.CarSetup.Chassis.Rear.DiffClutchPlates",
      ),
    ).toMatchObject({
      unit: "count",
      semanticId: "setup.drivetrain.differential-clutch-plates",
    });

    const camber = getTelemetryVariable("setup.alignment.camber");
    expect(camber.games["f1-2025"]).toMatchObject({
      kind: "simplified",
      sources: ["f1.setup.frontCamber", "f1.setup.rearCamber"],
    });
    expect(camber.games.acc).toMatchObject({
      kind: "simplified",
      sources: ["ACC.SetupFile.basicSetup.alignment.camber"],
    });
    expect(camber.games["ac-evo"]).toMatchObject({
      kind: "simplified",
      sources: ["ACEvo.SetupFile.basicSetup.alignment.camber"],
    });
    expect(camber.games.iracing).toMatchObject({
      kind: "normalized",
      nativeUnit: "value-with-unit",
    });

    const startingPressure = getTelemetryVariable(
      "setup.tires.starting-pressure",
    );
    expect(startingPressure.games["f1-2025"].kind).toBe("normalized");
    expect(startingPressure.games.acc.kind).toBe("normalized");
    expect(startingPressure.games["ac-evo"].kind).toBe("normalized");
    expect(startingPressure.games.iracing.kind).toBe("normalized");

    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "setup.iracing-car-setup",
      ),
    ).toBe(false);
  });

  test("keeps semantic IDs simulator-neutral even when only one source exists", () => {
    expect(
      TELEMETRY_CATALOG.variables
        .map((variable) => variable.id)
        .filter((id) =>
          /(^|[.-])(iracing|f1-2025|acc|ac-evo|fm-2023)([.-]|$)/i.test(
            id,
          ),
        ),
    ).toEqual([]);

    const oilLevel = getTelemetryVariable("engine.oil-level");
    expect(oilLevel).toMatchObject({
      canonicalUnit: "L",
      parentId: "engine",
    });
    expect(oilLevel.games.iracing).toMatchObject({
      kind: "normalized",
      nativeUnit: "l",
      sources: ["iRacing.OilLevel"],
      normalization: "normalize unit notation l to L",
    });
    expect(oilLevel.games["f1-2025"]).toMatchObject({
      kind: "unavailable",
      reason: "source-not-provided",
    });
    expect(
      IRACING_TELEMETRY_SOURCE_VARIABLES.find(
        (source) => source.path === "OilLevel",
      ),
    ).toMatchObject({
      semanticId: "engine.oil-level",
    });
  });

  test("maps native sector differences into detailed and comparable values", () => {
    const layout = getTelemetryVariable(
      "timing.sector.layout.start-fractions",
    );
    expect(layout.shape).toBe("array");
    expect(layout.games.iracing).toMatchObject({
      kind: "direct",
      nativeUnit: "fraction",
      freshness: "session-update",
    });
    expect(layout.games["f1-2025"]).toMatchObject({
      kind: "derived",
      sources: ["RaceIQ.Track.sectorStarts"],
    });

    const currentS1 = getTelemetryVariable(
      "timing.sector.current-lap.s1",
    );
    expect(currentS1.games["f1-2025"]).toMatchObject({
      kind: "direct",
      nativeUnit: "s",
      sources: ["f1.sector1Time"],
    });
    const currentS3 = getTelemetryVariable(
      "timing.sector.current-lap.s3",
    );
    expect(currentS3.games["f1-2025"]).toMatchObject({
      kind: "derived",
      sources: ["LiveSectorData.currentTimes"],
    });

    const lastCompleted = getTelemetryVariable(
      "timing.sector.last-completed-time",
    );
    expect(lastCompleted.games.acc).toMatchObject({
      kind: "normalized",
      nativeUnit: "ms",
      sources: ["acc.lastSectorTime"],
      normalization: "milliseconds / 1000",
    });

    const lastLap = getTelemetryVariable(
      "timing.sector.last-lap.times",
    );
    expect(lastLap.games["f1-2025"]).toMatchObject({
      kind: "derived",
      sources: [
        "f1.lapSectors.s1",
        "f1.lapSectors.s2",
        "f1.lapSectors.s3",
      ],
    });
    expect(lastLap.games.iracing).toMatchObject({
      kind: "derived",
      sources: [
        "iracing.sectorStarts",
        "iracing.lapDistancePct",
        "TelemetryPacket.CurrentLap",
        "TelemetryPacket.LastLap",
      ],
    });

    expect(
      getTelemetryVariable("timing.sector2-lap-distance-start").games[
        "f1-2025"
      ],
    ).toMatchObject({
      kind: "unavailable",
      reason: "parser-placeholder",
    });
  });

  test("merges equivalent all-sim source names under shared semantics", () => {
    expect(
      Object.fromEntries(
        Object.entries(getTelemetryVariable("aero.drs-active").games).map(
          ([gameId, mapping]) => [gameId, mapping.kind],
        ),
      ),
    ).toMatchObject({
      "f1-2025": "normalized",
      acc: "unavailable",
      "ac-evo": "direct",
    });

    const compound = getTelemetryVariable("tires.tire-compound");
    expect(compound.games["f1-2025"].kind).not.toBe("unavailable");
    expect(compound.games.acc.kind).toBe("simplified");
    expect(compound.games["ac-evo"].kind).toBe("simplified");
    expect(compound.games.iracing).toMatchObject({
      kind: "simplified",
      sources: ["iRacing.PlayerTireCompound"],
    });

    const competitorBest = getTelemetryVariable(
      "timing.competitor.best-lap-time",
    );
    expect(competitorBest.games["f1-2025"]).toMatchObject({
      kind: "direct",
      sources: ["f1.grid[].bestLapTime"],
    });
    const iracingBest = competitorBest.games.iracing;
    expect(iracingBest.kind).not.toBe("unavailable");
    if (iracingBest.kind === "unavailable") return;
    expect(iracingBest.sources).toContain(
      "iRacing.CarIdxBestLapTime",
    );
    expect(iracingBest.sources).toContain(
      "iRacing.SessionInfo.SessionInfo.Sessions[].ResultsPositions[].FastestTime",
    );
  });

  test("merges duplicate concepts while preserving source-specific detail", () => {
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "timing.lap-distance-pct",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "identity.track-length",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "race.incidents",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "race.is-on-track",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "tires.cold-pressure",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables
        .map((variable) => variable.id)
        .filter((id) => /-(?:fl|fr|rl|rr)-2$/.test(id)),
    ).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => variable.id === "tires.tire-slip-combined-fl-2",
      ),
    ).toBe(false);

    const lapFraction = getTelemetryVariable("timing.lap-fraction");
    expect(lapFraction.canonicalUnit).toBe("fraction");
    expect(lapFraction.games["f1-2025"].kind).toBe("derived");
    expect(lapFraction.games["ac-evo"].kind).toBe("derived");
    expect(lapFraction.games.iracing).toMatchObject({
      kind: "normalized",
      sources: ["iracing.lapDistancePct", "iRacing.LapDistPct"],
    });

    const trackLength = getTelemetryVariable("timing.track-length");
    expect(trackLength.games["f1-2025"]).toMatchObject({
      kind: "direct",
      sources: ["f1.trackLength"],
    });
    const iracingTrackLength = trackLength.games.iracing;
    expect(iracingTrackLength.kind).toBe("normalized");
    if (iracingTrackLength.kind !== "unavailable") {
      expect(iracingTrackLength.sources).toContain("iracing.trackLengthM");
      expect(iracingTrackLength.sources).toContain(
        "iRacing.SessionInfo.WeekendInfo.TrackLength",
      );
    }

    const speed = getTelemetryVariable("motion.speed");
    const brake = getTelemetryVariable("inputs.brake");
    for (const gameId of ["f1-2025", "acc", "ac-evo", "iracing"] as const) {
      expect(speed.games[gameId].kind).toBe("normalized");
      expect(brake.games[gameId].kind).toBe("normalized");
    }
    expect(getTelemetryVariable("timing.current-lap").games.iracing.kind).toBe(
      "derived",
    );
    expect(getTelemetryVariable("engine.power").games["f1-2025"]).toMatchObject({
      kind: "derived",
      execution: { kind: "derivation" },
    });
    expect(
      getTelemetryVariable("tires.tire-combined-slip").games["f1-2025"],
    ).toMatchObject({
      kind: "derived",
      execution: { kind: "derivation" },
    });
    expect(getTelemetryVariable("weather.weather-type").games.acc).toMatchObject({
      kind: "simplified",
      execution: { kind: "simplification" },
      limitations: expect.arrayContaining([expect.any(String)]),
    });
    expect(
      getTelemetryVariable("tires.wheel-rotation-speed").games["f1-2025"],
    ).toMatchObject({
      kind: "simplified",
      execution: { kind: "simplification" },
      limitations: expect.arrayContaining([expect.any(String)]),
    });

    const playerCarIndex = getTelemetryVariable("identity.player-car-index");
    expect(playerCarIndex.games.iracing).toMatchObject({
      sources: [
        "iracing.driverCarIdx",
        "iRacing.PlayerCarIdx",
        "iRacing.SessionInfo.DriverInfo.DriverCarIdx",
      ],
    });

    const sourceSemantics = new Map(
      IRACING_TELEMETRY_SOURCE_VARIABLES.map((source) => [
        source.path,
        source.semanticId,
      ]),
    );
    expect(sourceSemantics.get("PlayerIncidents")).toBe(
      "race.incident-flags",
    );
    expect(sourceSemantics.get("PlayerCarMyIncidentCount")).toBe(
      "race.player-incident-count",
    );
    expect(sourceSemantics.get("PlayerCarDriverIncidentCount")).toBe(
      "race.driver-incident-count",
    );
    expect(sourceSemantics.get("PlayerCarTeamIncidentCount")).toBe(
      "race.team-incident-count",
    );
    expect(sourceSemantics.get("IsOnTrack")).toBe("race.is-race-on");
    expect(sourceSemantics.get("LFcoldPressure")).toBe(
      "tires.tire-pressure",
    );
    expect(sourceSemantics.get("CarIdxFastRepairsUsed")).toBe(
      "race.competitor.fast-repairs-used",
    );
    expect(sourceSemantics.get("CarIdxTrackSurface")).toBe(
      "race.competitor.track-location",
    );
    expect(sourceSemantics.get("DCDriversSoFar")).toBe(
      "session.driver-change.drivers-used",
    );
    expect(sourceSemantics.get("DCLapStatus")).toBe(
      "race.driver-change-lap-status",
    );
    expect(sourceSemantics.get("LapLasNLapSeq")).toBe(
      "timing.n-lap-average.clean-lap-count",
    );
    expect(sourceSemantics.get("SessionLapsRemain")).toBe(
      "session.laps-remaining",
    );
    expect(sourceSemantics.get("SessionLapsRemainEx")).toBe(
      "session.laps-remaining",
    );
    expect(sourceSemantics.get("RadioTransmitCarIdx")).toBe(
      "diagnostics.radio.transmitting-car-index",
    );
    expect(sourceSemantics.get("P2P_Status")).toBe(
      "race.player.push-to-pass-active",
    );
    expect(sourceSemantics.get("CamCameraState")).toBe(
      "diagnostics.camera.state-flags",
    );
    expect(sourceSemantics.get("PitSvLFP")).toBe(
      "race.pit-service.tire-pressure",
    );
    expect(sourceSemantics.get("PitSvRRP")).toBe(
      "race.pit-service.tire-pressure",
    );
    expect(
      getTelemetrySources("fm-2023").find(
        (source) => source.path === "TelemetryPacket.SurfaceRumbleFL_2",
      )?.semanticId,
    ).toBe("tires.surface-rumble");
    expect(
      getTelemetrySources("fm-2023").find(
        (source) => source.path === "TelemetryPacket.TireSlipCombinedFL_2",
      )?.semanticId,
    ).toBe("tires.normalized-tire-slip-angle");
    expect(
      getTelemetrySources("fm-2023").find(
        (source) => source.path === "TelemetryPacket.TireSlipAngleFL",
      )?.semanticId,
    ).toBe("tires.normalized-tire-slip-angle");
    expect(getTelemetryVariable("tires.tire-slip-angle").games["fm-2023"])
      .toMatchObject({
        kind: "unavailable",
        reason: "source-not-provided",
      });
    expect(
      getTelemetryVariable("tires.normalized-tire-slip-angle").games[
        "fm-2023"
      ],
    ).toMatchObject({
      kind: "direct",
      nativeUnit: "ratio",
    });
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

  test("keeps detailed setup leaves under common source-neutral groups", () => {
    expect(
      getTelemetryChildren("setup.suspension.front-anti-roll-bar").map(
        (node) => node.id,
      ),
    ).toEqual([
      "setup.suspension.front-anti-roll-bar.arms",
      "setup.suspension.front-anti-roll-bar.blades",
      "setup.suspension.front-anti-roll-bar.diameter",
      "setup.suspension.front-anti-roll-bar.outer-diameter",
      "setup.suspension.front-anti-roll-bar.setting",
    ]);
    expect(
      getTelemetryChildren("setup.aero.rear-wing").map((node) => node.id),
    ).toEqual([
      "setup.aero.rear-wing.angle",
      "setup.aero.rear-wing.setting",
    ]);
    expect(
      getTelemetryVariable("setup.suspension.front-anti-roll-bar.setting")
        .shape,
    ).toBe("scalar");
    expect(
      getTelemetryVariable("setup.suspension.rear-anti-roll-bar.setting")
        .shape,
    ).toBe("scalar");

    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (source) =>
          source.path === "SessionInfo.CarSetup.Chassis.Front.ArbDiameter",
      ),
    ).toMatchObject({
      semanticId: "setup.suspension.front-anti-roll-bar.diameter",
    });
    expect(
      IRACING_SESSION_INFO_SOURCE_VARIABLES.find(
        (source) =>
          source.path === "SessionInfo.CarSetup.Chassis.Rear.WingAngle",
      ),
    ).toMatchObject({ semanticId: "setup.aero.rear-wing.angle" });
  });

  test("avoids ambiguous central labels and generic parser descriptions", () => {
    const duplicateLabels = TELEMETRY_CATALOG.variables
      .map((variable) => variable.label)
      .filter((label, index, labels) => labels.indexOf(label) !== index);
    expect(duplicateLabels).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables.filter((variable) =>
        /exposed by .* parser/i.test(variable.description),
      ),
    ).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables
        .map((variable) => variable.id)
        .filter((id) =>
          /weekend-info|driver-info|session-info|camera-info|radio-info|motion-ex/.test(
            id,
          ),
        ),
    ).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables
        .map((variable) => variable.id)
        .filter((id) =>
          /(car-idx|lastl|las-n|(?:^|\.)dc-|session-laps-remain-ex|-dd$|-ok$|p2-p|(?:^|\.)cam-|pit-sv|pit-opt)/.test(
            id,
          ),
        ),
    ).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables.flatMap((variable) =>
        Object.entries(variable.games).flatMap(([gameId, mapping]) => {
          if (mapping.kind === "unavailable") return [];
          const sources = Array.isArray(mapping.sources)
            ? mapping.sources
            : Object.values(mapping.sources).flat();
          return sources
            .filter((source) => source.startsWith("RaceIQ.ParserState."))
            .map((source) => `${gameId}:${variable.id}:${source}`);
        }),
      ),
    ).toEqual([]);
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
