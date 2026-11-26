import { describe, expect, test } from "bun:test";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";
import { getAcEvoTracks } from "@raceiq/game-ac-evo-metadata/racing/tracks/catalogs/ac-evo";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-ac-evo-metadata/session-identity";

describe("AC Evo catalog identity", () => {
  test("requires exact catalog strings", () => {
    const car = getAllAcEvoCars()[0]!.id;
    const track = getAcEvoTracks().keys().next().value!;
    expect(isCatalogCarId(car)).toBe(true);
    expect(isCatalogTrackId(track)).toBe(true);
    expect(isCatalogCarId(`${car} `)).toBe(false);
    expect(isCatalogTrackId(`${track} `)).toBe(false);
  });

  test("rejects missing identities", () => {
    expect(isCatalogCarId("not-a-catalog-identity")).toBe(false);
    expect(isCatalogTrackId("not-a-catalog-identity")).toBe(false);
  });
});
