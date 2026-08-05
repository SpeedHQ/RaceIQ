import { describe, expect, test } from "bun:test";
import {
  collectIRacingSessionInfoLeafPaths,
  getTelemetryVariable,
  IRACING_SESSION_INFO_SOURCE_VARIABLES,
  IRACING_TELEMETRY_SOURCE_VARIABLES,
  readFileSync,
  TELEMETRY_CATALOG,
} from "../../support/telemetry/catalog";

describe("semantic telemetry catalog iRacing sources", () => {
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
});
