import { describe, expect, test } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { getAllF1Cars } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { lmuCarCatalog, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { isCatalogCarId, isCatalogTrackId, isSessionIdentityInCatalog } from "../../src/games/session-identity";

describe("session catalog identity dispatch", () => {
  test("dispatches car and track identities for each game", () => {
    const cases: Array<[GameId, string, string]> = [
      ["acc", "33", "8"],
      ["ams2", "325487790", "165370945"],
      ["ac-evo", getAllAcEvoCars()[0]!.id, getAcEvoTracks().keys().next().value!],
      ["f1-2025", getAllF1Cars()[0]!.id, String(getF1Tracks().keys().next().value)],
      ["fm-2023", String(fmCarCatalog.keys().next().value), String(fmTrackCatalog.keys().next().value)],
      ["iracing", String(getAllIRacingCars()[0]!.ordinal), String(getAllIRacingTracks()[0]!.ordinal)],
      ["lmu", lmuCarCatalog[0]!.id, lmuTrackCatalog[0]!.id],
    ];
    for (const [game, car, track] of cases) {
      expect(isCatalogCarId(game, car)).toBe(true);
      expect(isCatalogTrackId(game, track)).toBe(true);
      expect(isSessionIdentityInCatalog(game, car, track)).toBe(true);
    }
  });

  test("unknown games are rejected", () => {
    const unknown = "unknown" as GameId;
    expect(isCatalogCarId(unknown, "33")).toBe(false);
    expect(isCatalogTrackId(unknown, "8")).toBe(false);
    expect(isSessionIdentityInCatalog(unknown, "33", "8")).toBe(false);
  });
});
