import { describe, expect, test } from "bun:test";
import { accCarRoutes } from "@raceiq/cars-catalogue/server";
import { getTrackBoundariesById } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import { getTrackOutlineById, getTrackRacelineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { isSessionIdentityInCatalog } from "../../../src/games/session-identity";

describe("ACC native identity consumers", () => {
  test("accepts catalog native and legacy identities without fuzzy matches", () => {
    expect(isSessionIdentityInCatalog("acc", "porsche_992_gt3_r", "barcelona")).toBe(true);
    expect(isSessionIdentityInCatalog("acc", "33", "8")).toBe(true);
    expect(isSessionIdentityInCatalog("acc", "porsche_992_gt3_r", "barcelon")).toBe(false);
  });

  test("serves the same class for native and legacy car identities", async () => {
    const native = await accCarRoutes.request("/api/acc/cars/porsche_992_gt3_r/class");
    const legacy = await accCarRoutes.request("/api/acc/cars/33/class");
    const nativeClass = await native.json();
    expect(nativeClass.class).toBeTruthy();
    expect(nativeClass).toEqual(await legacy.json());
    const unknown = await accCarRoutes.request("/api/acc/cars/porsche_992_gt3/class");
    expect(await unknown.json()).toEqual({ class: null });
  });

  test("resolves native track geometry using its catalog identity", () => {
    const legacy = getTrackBoundariesById("8", "acc");
    expect(legacy).not.toBeNull();
    expect(getTrackBoundariesById("barcelona", "acc")).toEqual(legacy);
    expect(getTrackBoundariesById("barcelon", "acc")).toBeNull();
    expect(getTrackOutlineById("barcelona", "acc")).toEqual(getTrackOutlineById("8", "acc"));
    expect(getTrackRacelineById("barcelona", "acc")).toEqual(getTrackRacelineById("8", "acc"));
  });
});
