import { describe, expect, test } from "bun:test";
import type { GameId } from "@raceiq/shared/games/ids";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { getAllF1Cars } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { lmuCarCatalog, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { registerAMS2Identity } from "@raceiq/game-ams2-metadata/index";
import { isCatalogCarId, isCatalogTrackId, isSessionIdentityInCatalog } from "../../src/games/session-identity";

describe("session catalog identity dispatch", () => {
  test("Forza and F1 accept decimal digits with leading zeroes only", () => {
    const cases = [
      ["fm-2023", String(fmCarCatalog.keys().next().value), String(fmTrackCatalog.keys().next().value)],
      ["f1-2025", getAllF1Cars()[0]!.id, String(getF1Tracks().keys().next().value)],
    ] as const;
    for (const [game, car, track] of cases) {
      expect(isSessionIdentityInCatalog(game, `0${car}`, `0${track}`)).toBe(true);
      for (const prefix of ["", " ", "+", "-"]) {
        const badCar = prefix ? `${prefix}${car}` : "";
        const badTrack = prefix ? `${prefix}${track}` : "";
        expect(isCatalogCarId(game, badCar)).toBe(false);
        expect(isCatalogTrackId(game, badTrack)).toBe(false);
      }
      expect(isCatalogCarId(game, `${car}.0`)).toBe(false);
      expect(isCatalogTrackId(game, `${track}.0`)).toBe(false);
    }
  });

  test("iRacing requires canonical ordinal strings", () => {
    const car = String(getAllIRacingCars()[0]!.ordinal);
    const track = String(getAllIRacingTracks()[0]!.ordinal);
    expect(isSessionIdentityInCatalog("iracing", car, track)).toBe(true);
    expect(isCatalogCarId("iracing", `0${car}`)).toBe(false);
    expect(isCatalogTrackId("iracing", `0${track}`)).toBe(false);
  });

  test("ACC accepts native and legacy identities without fuzzy matching", () => {
    expect(isSessionIdentityInCatalog("acc", "porsche_992_gt3_r", "barcelona")).toBe(true);
    expect(isSessionIdentityInCatalog("acc", "33", "8")).toBe(true);
    expect(isCatalogCarId("acc", "porsche_992_gt3")).toBe(false);
    expect(isCatalogTrackId("acc", "barcelon")).toBe(false);
    expect(isSessionIdentityInCatalog("acc", "033", "08")).toBe(true);
  });

  test("AC Evo and LMU require exact catalog strings", () => {
    const cases = [
      ["ac-evo", getAllAcEvoCars()[0]!.id, getAcEvoTracks().keys().next().value!],
      ["lmu", lmuCarCatalog[0]!.id, lmuTrackCatalog[0]!.id],
    ] as const;
    for (const [game, car, track] of cases) {
      expect(isSessionIdentityInCatalog(game, car, track)).toBe(true);
      expect(isCatalogCarId(game, `${car} `)).toBe(false);
      expect(isCatalogTrackId(game, `${track} `)).toBe(false);
    }
  });

  test("AMS2 accepts catalog and newly discovered identities", () => {
    expect(isSessionIdentityInCatalog("ams2", "325487790", "165370945")).toBe(true);
    registerAMS2Identity("test-session-car", "Car", "test-session-track", "Track");
    expect(isSessionIdentityInCatalog("ams2", "test-session-car", "test-session-track")).toBe(true);
  });

  test("unknown games and missing catalog identities are rejected", () => {
    const unknown = "unknown" as GameId;
    expect(isCatalogCarId(unknown, "33")).toBe(false);
    expect(isCatalogTrackId(unknown, "8")).toBe(false);
    expect(isSessionIdentityInCatalog(unknown, "33", "8")).toBe(false);
    for (const game of ["fm-2023", "f1-2025", "iracing", "acc", "ac-evo", "lmu", "ams2"] as const) {
      expect(isCatalogCarId(game, "not-a-catalog-identity")).toBe(false);
      expect(isCatalogTrackId(game, "not-a-catalog-identity")).toBe(false);
    }
  });
});
