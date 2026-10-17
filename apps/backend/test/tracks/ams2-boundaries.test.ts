import { expect, test } from "bun:test";
import { getTrackBoundariesByOrdinal } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import { ams2Adapter, getAMS2DiscoveredTrackName, injectDiscoveredAMS2Identity, registerAMS2Identity } from "@raceiq/game-ams2-metadata/index";
import { matchAMS2Layout } from "@raceiq/game-ams2-metadata/track-boundaries";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";

test("AMS2 Indy boundaries preserve native telemetry coordinates and paired edges", () => {
  injectDiscoveredAMS2Identity([], [{ ordinal: 165370945, name: "BrandsHatch - BrandsHatch_Indy" }]);
  const boundaries = getTrackBoundariesByOrdinal(165370945, "ams2")!;
  expect(boundaries).not.toBeNull();
  expect(boundaries.leftEdge).toHaveLength(379);
  expect(boundaries.rightEdge).toHaveLength(379);
  expect(boundaries.centerLine).toHaveLength(379);
  // Native world origin and signs must survive export: no SVG translation or reflection.
  expect(boundaries.centerLine![0]).toEqual({ x: 29.7044, z: 14.4233 });
  for (let i = 0; i < boundaries.leftEdge.length; i++) {
    const left = boundaries.leftEdge[i], right = boundaries.rightEdge[i];
    expect(Number.isFinite(left.x + left.z + right.x + right.z)).toBe(true);
    expect(Math.hypot(right.x - left.x, right.z - left.z)).toBeGreaterThan(2);
    expect(Math.hypot(right.x - left.x, right.z - left.z)).toBeLessThan(40);
  }
  expect(boundaries.pitLane).toBeNull();
});

test("all bundled original layouts load by exact discovered variation", () => {
  const catalog = JSON.parse(readFileSync(resolve(gameAssetsDir("ams2"), "tracks/catalog.json"), "utf8"));
  expect(catalog.layouts).toHaveLength(235);
  expect(new Set(catalog.layouts.map((entry: { layout: string }) => entry.layout.toLowerCase())).size).toBe(235);
  for (const [index, entry] of catalog.layouts.entries()) {
    const ordinal = 900000000 + index;
    registerAMS2Identity(1, "Test car", ordinal, `Test location - ${entry.layout}`, entry.lengthM);
    const boundaries = getTrackBoundariesByOrdinal(ordinal, "ams2");
    expect(boundaries, entry.layout).not.toBeNull();
    expect(boundaries!.leftEdge.length, entry.layout).toBe(boundaries!.rightEdge.length);
    expect(boundaries!.centerLine!.length, entry.layout).toBe(boundaries!.leftEdge.length);
    for (const points of [boundaries!.leftEdge, boundaries!.rightEdge, boundaries!.centerLine!]) expect(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.z)), entry.layout).toBe(true);
  }
});

test("ambiguous, guessed and length-mismatched layout matches are refused", () => {
  const entries = [{ layout: "BrandsHatch_Indy", file: "brandshatch-indy-boundaries.json", lengthM: 1932.822876 }];
  expect(matchAMS2Layout("BrandsHatch - brandshatch_indy", undefined, entries)).toEqual(entries[0]);
  expect(matchAMS2Layout("BrandsHatch - BrandsHatch_GP", 1932, entries)).toBeNull();
  expect(matchAMS2Layout("Brands Hatch Indy", undefined, entries)).toBeNull();
  expect(matchAMS2Layout("BrandsHatch - BrandsHatch_Indy", 4000, entries)).toBeNull();
  expect(matchAMS2Layout("BrandsHatch - BrandsHatch_Indy", undefined, [...entries, ...entries])).toBeNull();
  expect(getTrackBoundariesByOrdinal(899999999, "ams2")).toBeNull();
});

test("missing identities are retried and cached geometry cannot bypass a live length mismatch", () => {
  const ordinal = 899999998;
  expect(getTrackBoundariesByOrdinal(ordinal, "ams2")).toBeNull();
  injectDiscoveredAMS2Identity([], [{ ordinal, name: "BrandsHatch - BrandsHatch_Indy" }]);
  const first = getTrackBoundariesByOrdinal(ordinal, "ams2")!;
  expect(first).not.toBeNull();
  first.leftEdge[0].x = 123456;
  expect(getTrackBoundariesByOrdinal(ordinal, "ams2")!.leftEdge[0].x).not.toBe(123456);
  registerAMS2Identity(1, "Test car", ordinal, "BrandsHatch - BrandsHatch_Indy", 4000);
  expect(getTrackBoundariesByOrdinal(ordinal, "ams2")).toBeNull();
});

test("AMS2 map lookup does not substitute Indy for another track", () => {
  expect(getTrackBoundariesByOrdinal(1, "ams2")).toBeNull();
  expect(getTrackBoundariesByOrdinal(165370945, "lmu")).toBeNull();
});

test("persisted string track identities restore map lookup after startup", () => {
  injectDiscoveredAMS2Identity([], [{ trackId: "899999997", name: "BrandsHatch - BrandsHatch_Indy" }]);
  expect(getTrackBoundariesByOrdinal(899999997, "ams2")?.leftEdge).toHaveLength(379);
});

test("AMS2 Indy reuses only the matching shared name and preserves native identity", () => {
  const id = "165370945";
  injectDiscoveredAMS2Identity([], [{ trackId: id, name: "BrandsHatch - BrandsHatch_Indy" }, { trackId: "899999996", name: "BrandsHatch - BrandsHatch_GP" }, { trackId: "1250765071", name: "Cordoba - Cordoba_International" }]);
  expect(ams2Adapter.getTrackName(id)).toBe("Brands Hatch Indy");
  expect(ams2Adapter.getSharedTrackName?.(id)).toBe("brands-hatch-indy");
  expect(getAMS2DiscoveredTrackName(id)).toBe("BrandsHatch - BrandsHatch_Indy");
  expect(ams2Adapter.getTrackIdByName?.("Brands Hatch Indy")).toBe(id);
  expect(ams2Adapter.getTrackIdByName?.("BrandsHatch - BrandsHatch_Indy")).toBe(id);
  expect(ams2Adapter.getSharedTrackName?.("899999996")).toBeUndefined();
  expect(ams2Adapter.getSharedTrackName?.("1250765071")).toBeUndefined();
  expect(ams2Adapter.getTrackName("1250765071")).toBe("Cordoba - Cordoba_International");
  expect(getTrackBoundariesByOrdinal(Number(id), "ams2")?.leftEdge).toHaveLength(379);
});

test("Cordoba International uses the recording-verified standard archive, not GP", () => {
  const ordinal = 1250765071;
  registerAMS2Identity(1, "Test car", ordinal, "Cordoba - Cordoba_International", 3655.272705078125);
  const boundaries = getTrackBoundariesByOrdinal(ordinal, "ams2")!;
  const original = JSON.parse(readFileSync(resolve(gameAssetsDir("ams2"), "tracks/cordoba-boundaries.json"), "utf8"));
  expect(boundaries).not.toBeNull();
  expect(boundaries.leftEdge).toEqual(original.leftEdge);
  expect(boundaries.rightEdge).toEqual(original.rightEdge);
  const entries = [{ layout: "Cordoba", file: "cordoba-boundaries.json", lengthM: 3655.272461 }];
  expect(matchAMS2Layout("Cordoba - Cordoba_International", 4055.424805, entries)).toBeNull();
  expect(matchAMS2Layout("Other location - Cordoba_International", undefined, entries)).toBeNull();
});
