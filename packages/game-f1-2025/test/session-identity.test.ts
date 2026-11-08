import { describe, expect, test } from "bun:test";
import { getAllF1Cars } from "@raceiq/game-f1-2025-metadata/racing/cars/f1";
import { getF1Tracks } from "@raceiq/game-f1-2025-metadata/racing/tracks/catalogs/f1";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-f1-2025-metadata/session-identity";

describe("F1 catalog identity", () => {
  test("accepts decimal digits with leading zeroes only", () => {
    const car = getAllF1Cars()[0]!.id;
    const track = String(getF1Tracks().keys().next().value);
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
