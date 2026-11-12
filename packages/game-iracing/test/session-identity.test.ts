import { describe, expect, test } from "bun:test";
import { getAllIRacingCars } from "@raceiq/game-iracing-metadata/racing/cars/iracing";
import { getAllIRacingTracks } from "@raceiq/game-iracing-metadata/racing/tracks/catalogs/iracing";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-iracing-metadata/session-identity";

describe("iRacing catalog identity", () => {
  test("requires canonical ordinal strings", () => {
    const car = String(getAllIRacingCars()[0]!.ordinal);
    const track = String(getAllIRacingTracks()[0]!.ordinal);
    expect(isCatalogCarId(car)).toBe(true);
    expect(isCatalogTrackId(track)).toBe(true);
    expect(isCatalogCarId(`0${car}`)).toBe(false);
    expect(isCatalogTrackId(`0${track}`)).toBe(false);
  });

  test("rejects missing identities", () => {
    expect(isCatalogCarId("not-a-catalog-identity")).toBe(false);
    expect(isCatalogTrackId("not-a-catalog-identity")).toBe(false);
  });
});
