import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { loadExtractedBoundary } from "../../shared/racing/tracks/geometry/extracted";
import { loadLegacyOutlineByOrdinal } from "../../shared/racing/tracks/geometry/legacy";
import { loadBundledPointCsv } from "../../shared/racing/tracks/resolve-name";
import {
  bundledGeometryPath,
  bundledLegacyGeometryPath,
  bundledSharedAccGeometryPath,
  findTrackAssetIdentities,
  getTrackAssetIdentity,
  legacyGeometryOwnerIdentity,
  sharedAccGeometrySlug,
} from "../../shared/racing/tracks/storage/assets";

describe("canonical track geometry assets", () => {
  test("resolves exact game geometry through registry identity", () => {
    const identity = getTrackAssetIdentity("fm-2023", 1641);
    expect(identity).toMatchObject({ venuePath: "hakone", layoutSlug: "club" });
    expect(existsSync(bundledGeometryPath(identity!, "centerline"))).toBe(true);
    expect(loadBundledPointCsv(1641, "fm-2023", "centerline")?.length).toBeGreaterThan(20);
  });

  test("shares one ACC source across current and 2019 assignments", () => {
    const current = getTrackAssetIdentity("acc", 6)!;
    const historical = getTrackAssetIdentity("acc", 17)!;
    const slug = sharedAccGeometrySlug(current);
    expect(slug).toBe("spa");
    expect(sharedAccGeometrySlug(historical)).toBe(slug);
    expect(bundledSharedAccGeometryPath(current, slug!, "centerline")).toBe(bundledSharedAccGeometryPath(historical, slug!, "centerline"));
    expect(loadBundledPointCsv(6, "acc", "centerline")).toEqual(loadBundledPointCsv(17, "acc", "centerline"));
  });

  test("uses explicit ACC fallback only when AC Evo has no ideal line", () => {
    const identity = findTrackAssetIdentities("silverstone", "ac-evo")[0]!;
    expect(existsSync(bundledGeometryPath(identity, "centerline"))).toBe(false);
    expect(loadBundledPointCsv(identity.ordinal, "ac-evo", "centerline")?.length).toBeGreaterThan(20);
    expect(loadExtractedBoundary(identity.ordinal, "ac-evo")?.leftEdge.length).toBeGreaterThan(20);
  });

  test("loads game-owned legacy geometry across assigned games", () => {
    const owner = legacyGeometryOwnerIdentity("spa");
    expect(owner).toMatchObject({ gameId: "fm-2023", ordinal: 530 });
    expect(existsSync(bundledLegacyGeometryPath(owner!, "centerline"))).toBe(true);
    expect(loadLegacyOutlineByOrdinal(10, "f1-2025")?.length).toBeGreaterThan(20);
    expect(loadLegacyOutlineByOrdinal(523, "iracing")).toEqual(loadLegacyOutlineByOrdinal(530, "fm-2023"));
  });
});
