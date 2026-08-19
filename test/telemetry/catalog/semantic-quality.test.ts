import { describe, expect, test } from "bun:test";
import { assertCatalogSemanticQuality } from "../../../scripts/catalog/contract-provenance";
import { dimensionForUnit } from "../../../scripts/catalog/contract-inference";
import { GAME_IDS } from "../../../scripts/catalog/model";
import type {
  CatalogVariable,
  GameId,
  GameLink,
} from "../../../scripts/catalog/model";

function unavailableGames(
  overrides: Partial<Record<GameId, GameLink>> = {},
): Record<GameId, GameLink> {
  const games = Object.fromEntries(
    GAME_IDS.map((gameId) => [
      gameId,
      {
        kind: "unavailable",
        reason: "source-not-provided",
        description: "Not available in focused quality fixture.",
      },
    ]),
  ) as Record<GameId, GameLink>;
  return { ...games, ...overrides };
}

function variable(
  id: string,
  canonicalUnit: string,
  games: Record<GameId, GameLink> = unavailableGames(),
  shape: CatalogVariable["shape"] = "scalar",
): CatalogVariable {
  return {
    id,
    label: id,
    description: id,
    parentId: id.split(".")[0],
    canonicalUnit,
    dimensions: dimensionForUnit(canonicalUnit),
    shape,
    games,
  };
}

function assertQuality(variables: CatalogVariable[]): void {
  assertCatalogSemanticQuality(
    new Map(variables.map((entry) => [entry.id, entry])),
  );
}

describe("catalog semantic quality", () => {
  test("rejects duplicate qualifier and fuel representation synonyms", () => {
    expect(() =>
      assertQuality([
        variable("engine.current-boost", "bar"),
        variable("engine.boost", "bar"),
      ]),
    ).toThrow("Duplicate telemetry concept engine.boost and engine.current-boost");

    const legacyFuelVolume = ["fuel", "fuel"].join(".");
    expect(() =>
      assertQuality([
        variable(legacyFuelVolume, "L"),
        variable("fuel.remaining-volume", "L"),
      ]),
    ).toThrow(
      `Duplicate telemetry concept ${legacyFuelVolume} and fuel.remaining-volume`,
    );
  });

  test("rejects source-representation suffixes", () => {
    for (const id of [
      "timing.delta-ms",
      "timing.pit-lane-time-in-ms",
      "engine.coolant-temp-c",
    ]) {
      expect(() => assertQuality([variable(id, "s")])).toThrow(
        `Representation suffix is forbidden in semantic ID ${id}`,
      );
    }
  });

  test("rejects recognized source dimension conflicts", () => {
    const mapping: GameLink = {
      kind: "direct",
      nativeUnit: "s",
      sources: ["TelemetryPacket.Speed"],
      freshness: "continuous",
      description: "Invalid focused fixture.",
    };
    expect(() =>
      assertQuality([
        variable(
          "motion.speed",
          "m/s",
          unavailableGames({ acc: mapping }),
        ),
      ]),
    ).toThrow("Telemetry mapping acc:motion.speed conflicts");
  });

  test("permits only documented normalized dimension changes", () => {
    const steering: GameLink = {
      kind: "normalized",
      nativeUnit: "rad",
      sources: ["iRacing.SteeringWheelAngle"],
      freshness: "continuous",
      normalization: "divide physical steering angle by maximum steering angle",
      description: "Documented physical-angle conversion.",
    };
    const lapTime: GameLink = {
      kind: "normalized",
      nativeUnit: "text",
      sources: ["acc.acEvo.bestLapTime"],
      freshness: "continuous",
      normalization: "parse formatted lap duration text as seconds",
      description: "Documented text duration conversion.",
    };
    expect(() =>
      assertQuality([
        variable(
          "inputs.steering",
          "ratio",
          unavailableGames({ iracing: steering }),
        ),
        variable(
          "timing.best-lap-time",
          "s",
          unavailableGames({ "ac-evo": lapTime }),
        ),
      ]),
    ).not.toThrow();
  });

  test("requires declared inputs for derived mappings", () => {
    const missingInputs: GameLink = {
      kind: "derived",
      nativeUnit: "fraction",
      sources: ["fuel.remaining-fraction"],
      freshness: "continuous",
      normalization: "fraction * 100",
      description: "Invalid derived fixture.",
    };
    expect(() =>
      assertQuality([
        variable(
          "fuel.remaining-percent",
          "%",
          unavailableGames({ acc: missingInputs }),
        ),
      ]),
    ).toThrow("must declare derivation inputs");

    const declared: GameLink = {
      ...missingInputs,
      execution: {
        kind: "derivation",
        id: "test:fuel.remaining-percent:derived",
        version: "test",
        codeHash: "test",
        deterministic: true,
        declaredInputs: ["fuel.remaining-fraction"],
        missingDataPolicy: "require-all",
      },
    };
    expect(() =>
      assertQuality([
        variable(
          "fuel.remaining-percent",
          "%",
          unavailableGames({ acc: declared }),
        ),
      ]),
    ).not.toThrow();
  });

  test("rejects scalar three-corner wheel families", () => {
    expect(() =>
      assertQuality([
        variable("tires.blistering-fl", "%"),
        variable("tires.blistering-fr", "%"),
        variable("tires.blistering-rl", "%"),
      ]),
    ).toThrow("Scalar wheel family tires.blistering defines fl, fr, rl");
  });

  test("preserves intentional exceptions and representation distinctions", () => {
    expect(() =>
      assertQuality([
        variable("engine.current-engine-rpm", "rpm"),
        variable("engine.engine0-rpm", "rpm"),
        variable("timing.track-length", "m"),
        variable("timing.official-track-length", "m"),
        variable("tire.temperature.average", "°C"),
        variable("tire.temperature.current-average", "°C"),
        variable("fuel.remaining-volume", "L"),
        variable("fuel.remaining-fraction", "fraction"),
        variable("fuel.remaining-percent", "%"),
      ]),
    ).not.toThrow();
  });
});
