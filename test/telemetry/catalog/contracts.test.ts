import { describe, expect, test } from "bun:test";
import {
  assertDirectToSimplifiedCompatibilityReviews,
  getTelemetrySources,
  getTelemetryVariable,
  IRACING_TELEMETRY_SOURCE_VARIABLES,
  isTelemetryEnumValue,
  KNOWN_GAME_IDS,
  TELEMETRY_CATALOG,
  TELEMETRY_CATALOG_VERSION,
} from "../../support/telemetry/catalog";

describe("semantic telemetry catalog contracts", () => {
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
        expect(Object.keys(mapping.provenance).sort()).toEqual([
          "artifact",
          "origin",
        ]);
        expect(
          TELEMETRY_CATALOG.metadata.sourceHashes[mapping.provenance.artifact],
        ).toMatch(/^[a-f0-9]{64}$/);
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
  test("deduplicates source hashes and attributes projections to their artifacts", () => {
    const mappingArtifacts = TELEMETRY_CATALOG.variables.flatMap((variable) =>
      Object.values(variable.games).flatMap((mapping) =>
        mapping.kind === "unavailable" ? [] : [mapping.provenance.artifact],
      ),
    );
    expect(Object.keys(TELEMETRY_CATALOG.metadata.sourceHashes).sort()).toEqual(
      [...new Set(mappingArtifacts)].sort(),
    );
    const setupProjection =
      getTelemetryVariable("setup.aero.rear-wing.setting").games.acc;
    if (setupProjection.kind === "unavailable") {
      throw new Error("Expected ACC rear-wing setup projection");
    }
    expect(setupProjection.provenance).toEqual({
      origin: "projection",
      artifact: "shared/racing/setups/schema.ts",
    });
    const sectorDerivation =
      getTelemetryVariable("timing.sector.current-index").games["fm-2023"];
    if (sectorDerivation.kind === "unavailable") {
      throw new Error("Expected Forza current-sector derivation");
    }
    expect(sectorDerivation.provenance).toEqual({
      origin: "derivation",
      artifact: "scripts/catalog/derived-projections.ts",
    });
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
  test("merges duplicate concepts while preserving source-specific detail", () => {
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "timing.lap-distance-pct",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "identity.track-length",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "race.incidents",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "race.is-on-track",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "tires.cold-pressure",
      ),
    ).toBe(false);
    expect(
      TELEMETRY_CATALOG.variables
        .map((variable) => String(variable.id))
        .filter((id) => /-(?:fl|fr|rl|rr)-2$/.test(id)),
    ).toEqual([]);
    expect(
      TELEMETRY_CATALOG.variables.some(
        (variable) => String(variable.id) === "tires.tire-slip-combined-fl-2",
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
    const accWeather = getTelemetryVariable("weather.weather-type").games.acc;
    expect(accWeather).toMatchObject({
      kind: "simplified",
      execution: { kind: "simplification" },
    });
    // Keep asymmetric matchers outside toMatchObject: Bun otherwise replaces shared catalog arrays with matcher objects.
    expect(accWeather.kind === "unavailable" ? [] : accWeather.limitations).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );
    const f1WheelSpeed = getTelemetryVariable("tires.wheel-rotation-speed").games["f1-2025"];
    expect(f1WheelSpeed).toMatchObject({
      kind: "simplified",
      execution: { kind: "simplification" },
    });
    expect(f1WheelSpeed.kind === "unavailable" ? [] : f1WheelSpeed.limitations).toEqual(
      expect.arrayContaining([expect.any(String)]),
    );

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
});
