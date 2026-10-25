import { expect, test } from "bun:test";
import { getTrackBoundariesByOrdinal } from "@raceiq/game-catalogs/racing/tracks/geometry/extracted";
import { ams2Adapter, ams2CarCatalog, ams2TrackCatalog, getAMS2CatalogTrack, getAMS2DiscoveredTrackName, injectDiscoveredAMS2Identity, registerAMS2Identity } from "@raceiq/game-ams2-metadata/index";
import { ams2IdentityId } from "@raceiq/game-ams2-metadata/identity";
import { getTrackOutlineById } from "@raceiq/game-catalogs/racing/tracks/recording/outlines";
import { matchAMS2Layout } from "@raceiq/game-ams2-metadata/track-boundaries";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gameAssetsDir } from "@raceiq/shared/platform/runtime/data-paths";

test("AMS2 Indy boundaries preserve native telemetry coordinates and paired edges", () => {
  injectDiscoveredAMS2Identity([], [{ ordinal: 165370945, name: "BrandsHatch - BrandsHatch_Indy" }]);
  const boundaries = getTrackBoundariesByOrdinal(165370945, "ams2")!;
  expect(boundaries).not.toBeNull();
  // The SVG Z command explicitly closes the 379-point native path.
  expect(boundaries.leftEdge).toHaveLength(380);
  expect(boundaries.rightEdge).toHaveLength(380);
  expect(boundaries.centerLine).toHaveLength(380);
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
  expect(getTrackBoundariesByOrdinal(899999997, "ams2")?.leftEdge).toHaveLength(380);
});

test("AMS2 Indy reuses only the matching shared name and preserves native identity", () => {
  const id = "165370945";
  injectDiscoveredAMS2Identity([], [{ trackId: id, name: "BrandsHatch - BrandsHatch_Indy" }, { trackId: "899999996", name: "BrandsHatch - BrandsHatch_GP" }, { trackId: "1250765071", name: "Cordoba - Cordoba_International" }]);
  expect(ams2Adapter.getTrackName(id)).toBe("Brands Hatch Indy");
  expect(ams2Adapter.getSharedTrackName?.(id)).toBe("brands-hatch-indy");
  expect(getAMS2DiscoveredTrackName(id)).toBe("BrandsHatch - BrandsHatch_Indy");
  expect(ams2Adapter.getTrackIdByName?.("Brands Hatch Indy")).toBe(id);
  expect(ams2Adapter.getTrackIdByName?.("BrandsHatch - BrandsHatch_Indy")).toBe(id);
  expect(ams2Adapter.getSharedTrackName?.("899999996")).toBe("brands-hatch");
  expect(ams2Adapter.getSharedTrackName?.("1250765071")).toBeUndefined();
  expect(ams2Adapter.getTrackName("1250765071")).toBe("Cordoba International");
  expect(getTrackBoundariesByOrdinal(Number(id), "ams2")?.leftEdge).toHaveLength(380);
});

test("server inventory preserves recorded IDs and keeps historical and layout facts separate", () => {
  expect(ams2IdentityId("Volkswagen Polo")).toBe("325487790");
  expect(ams2IdentityId("Porsche 911 GT3 R")).toBe("854916192");
  expect(ams2IdentityId("BrandsHatch - BrandsHatch_Indy")).toBe("165370945");
  expect(ams2CarCatalog).toHaveLength(260);
  expect(ams2TrackCatalog).toHaveLength(222);
  expect(new Set(ams2CarCatalog.map(car => car.id)).size).toBe(260);
  expect(new Set(ams2TrackCatalog.map(track => track.id)).size).toBe(222);
  const p217=ams2CarCatalog.find(car => car.name === "Ligier JS P217")!;
  expect(p217.serverIds).toHaveLength(2);
  expect(p217.classes).toEqual(["LMP2","LMP2_Gen1"]);
  const historic=ams2TrackCatalog.find(track => track.layout === "Spa_Francorchamps_1970")!;
  const modern=ams2TrackCatalog.find(track => track.layout === "Spa_Francorchamps_2022")!;
  expect(historic.commonTrackName).toBeNull();
  expect(modern.commonTrackName).toBe("spa");
  for(const track of ams2TrackCatalog) if(track.commonTrackName) {
    expect(readFileSync(resolve(import.meta.dir,"../../../../shared/data/tracks/meta",`${track.commonTrackName}.json`),"utf8").length).toBeGreaterThan(0);
  }
});

test("cold inventory geometry and legacy aliases use only native AMS2 outlines", () => {
  const track=ams2TrackCatalog.find(track => track.layout === "Donington_GP")!;
  const outline=getTrackOutlineById(track.id,"ams2");
  const expected=getTrackBoundariesByOrdinal(Number(track.id),"ams2")!.centerLine!;
  expect(outline).toEqual(expected);
  expect(outline!.length).toBeGreaterThan(100);
  const rawName="Donington - Donington_GP", legacyId=ams2IdentityId(rawName);
  injectDiscoveredAMS2Identity([], [{trackId:legacyId,name:rawName}]);
  expect(getAMS2CatalogTrack(legacyId)?.id).toBe(track.id);
  expect(ams2Adapter.getSharedTrackName?.(legacyId)).toBe("donington");
  expect(getTrackOutlineById(legacyId,"ams2")).toEqual(expected);
  expect(getTrackOutlineById("2147483647","ams2","spa")).toBeNull();
});

test("Cordoba International uses the recording-verified standard archive, not GP", () => {
  const ordinal = 1250765071;
  registerAMS2Identity(1, "Test car", ordinal, "Cordoba - Cordoba_International", 3655.272705078125);
  const boundaries = getTrackBoundariesByOrdinal(ordinal, "ams2")!;
  const original = JSON.parse(readFileSync(resolve(gameAssetsDir("ams2"), "tracks/cordoba-boundaries.json"), "utf8"));
  expect(boundaries).not.toBeNull();
  expect(boundaries.leftEdge).toEqual([...original.leftEdge, original.leftEdge[0]]);
  expect(boundaries.rightEdge).toEqual([...original.rightEdge, original.rightEdge[0]]);
  const entries = [{ layout: "Cordoba", file: "cordoba-boundaries.json", lengthM: 3655.272461 }];
  expect(matchAMS2Layout("Cordoba - Cordoba_International", 4055.424805, entries)).toBeNull();
  expect(matchAMS2Layout("Other location - Cordoba_International", undefined, entries)).toBeNull();
});

test("observed telemetry wins over a colliding server inventory ID", () => {
  const entry = ams2TrackCatalog.find(track => track.layout === "Donington_Nat")!;
  injectDiscoveredAMS2Identity([], [{trackId: entry.id, name: "Custom location - Unlisted_layout"}]);
  expect(getAMS2CatalogTrack(entry.id)).toBeUndefined();
  expect(ams2Adapter.getTrackName(entry.id)).toBe("Custom location - Unlisted_layout");
  expect(ams2Adapter.getSharedTrackName?.(entry.id)).toBeUndefined();
  expect(getTrackBoundariesByOrdinal(Number(entry.id), "ams2")).toBeNull();
});
