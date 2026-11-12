import { describe, expect, test } from "bun:test";
import { lmuCarCatalog, lmuTrackCatalog } from "@raceiq/game-lmu-metadata/catalog";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-lmu-metadata/session-identity";

describe("LMU catalog identity", () => {
  test("requires exact catalog strings", () => {
    const car = lmuCarCatalog[0]!.id;
    const track = lmuTrackCatalog[0]!.id;
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
