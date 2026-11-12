import { describe, expect, test } from "bun:test";
import { fmCarCatalog } from "@raceiq/game-fm-2023-metadata/racing/cars/fm";
import { fmTrackCatalog } from "@raceiq/game-fm-2023-metadata/racing/tracks/catalogs/fm";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-fm-2023-metadata/session-identity";

describe("Forza catalog identity", () => {
  test("accepts decimal digits with leading zeroes only", () => {
    const car = String(fmCarCatalog.keys().next().value);
    const track = String(fmTrackCatalog.keys().next().value);
    expect(isCatalogCarId(`0${car}`)).toBe(true);
    expect(isCatalogTrackId(`0${track}`)).toBe(true);
    for (const prefix of ["", " ", "+", "-"]) {
      expect(isCatalogCarId(prefix ? `${prefix}${car}` : "")).toBe(false);
      expect(isCatalogTrackId(prefix ? `${prefix}${track}` : "")).toBe(false);
    }
    expect(isCatalogCarId(`${car}.0`)).toBe(false);
    expect(isCatalogTrackId(`${track}.0`)).toBe(false);
  });

  test("rejects missing identities", () => {
    expect(isCatalogCarId("not-a-catalog-identity")).toBe(false);
    expect(isCatalogTrackId("not-a-catalog-identity")).toBe(false);
  });
});
