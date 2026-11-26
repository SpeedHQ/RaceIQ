import { describe, expect, test } from "bun:test";
import { isCatalogCarId, isCatalogTrackId } from "@raceiq/game-acc-metadata/session-identity";

describe("ACC catalog identity", () => {
  test("retains numeric catalog identities", () => {
    expect(isCatalogCarId("porsche_992_gt3_r")).toBe(false);
    expect(isCatalogTrackId("barcelona")).toBe(false);
    expect(isCatalogCarId("33")).toBe(true);
    expect(isCatalogTrackId("8")).toBe(true);
    expect(isCatalogCarId("porsche_992_gt3")).toBe(false);
    expect(isCatalogTrackId("barcelon")).toBe(false);
    expect(isCatalogCarId("033")).toBe(false);
    expect(isCatalogTrackId("08")).toBe(true);
  });

  test("rejects missing identities", () => {
    expect(isCatalogCarId("not-a-catalog-identity")).toBe(false);
    expect(isCatalogTrackId("not-a-catalog-identity")).toBe(false);
  });
});
