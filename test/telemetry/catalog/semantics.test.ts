import { describe, expect, test } from "bun:test";
import {
  getTelemetryChildren,
  getTelemetryVariable,
  IRACING_SESSION_INFO_SOURCE_VARIABLES,
  IRACING_TELEMETRY_SOURCE_VARIABLES,
  TELEMETRY_CATALOG,
} from "../../support/telemetry/catalog";

describe("semantic telemetry catalog", () => {







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
      FL: ["TelemetryPacket.TireTempFL"],
      FR: ["TelemetryPacket.TireTempFR"],
      RL: ["TelemetryPacket.TireTempRL"],
      RR: ["TelemetryPacket.TireTempRR"],
    });
    expect(iracing.normalization).toBe(
      "use packet-provided representative carcass temperature per tire",
    );

    expect(
      getTelemetryVariable("tire.temperature.carcass.average").games.iracing,
    ).toMatchObject({
      kind: "simplified",
      freshness: "pit-snapshot",
    });
  });

  test("keeps iRacing fuel capacity static across long sessions", () => {
    expect(getTelemetryVariable("fuel.capacity").games.iracing).toMatchObject({
      kind: "direct",
      nativeUnit: "L",
      freshness: "static",
      sources: expect.arrayContaining([
        "TelemetryPacket.FuelCapacity",
        "iRacing.SessionInfo.DriverInfo.DriverCarFuelMaxLtr",
      ]),
    });
  });

  test("does not label F1 fuel mass as litre capacity or volume", () => {
    expect(getTelemetryVariable("fuel.capacity").games["f1-2025"]).toMatchObject({
      kind: "unavailable",
      reason: "source-not-provided",
    });
    expect(getTelemetryVariable("fuel.remaining-volume").games["f1-2025"]).toMatchObject({
      kind: "unavailable",
      reason: "source-not-provided",
    });
    expect(getTelemetryVariable("fuel.remaining-fraction").games["f1-2025"]).toMatchObject({
      kind: "direct",
      nativeUnit: "fraction",
    });
    expect(getTelemetryVariable("fuel.remaining-percent").games["f1-2025"]).toMatchObject({
      kind: "derived",
      nativeUnit: "fraction",
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
      "f1-2025": "direct",
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



  test("keeps detailed setup leaves under common source-neutral groups", () => {
    expect(
      getTelemetryChildren("setup.suspension.front-anti-roll-bar").map(
        (node) => node.id,
      ),
    ).toEqual([
      "setup.suspension.front-anti-roll-bar.arms",
      "setup.suspension.front-anti-roll-bar.blades",
      "setup.suspension.front-anti-roll-bar.connection",
      "setup.suspension.front-anti-roll-bar.diameter",
      "setup.suspension.front-anti-roll-bar.outer-diameter",
      "setup.suspension.front-anti-roll-bar.rate",
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

});
