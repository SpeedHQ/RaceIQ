import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { loadExtractedBoundary } from "../../shared/racing/tracks/geometry/extracted";
import { loadSharedOutline } from "../../shared/racing/tracks/geometry/shared";
import { loadBundledPointCsv } from "../../shared/racing/tracks/resolve-name";
import { bundledGeometryPath, bundledSharedGeometryPath, findTrackAssetIdentities, getTrackAssetIdentity, sharedAccGeometrySlug } from "../../shared/racing/tracks/storage/assets";

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
    expect(bundledSharedGeometryPath(current, "acc", slug!, "centerline")).toBe(bundledSharedGeometryPath(historical, "acc", slug!, "centerline"));
    expect(loadBundledPointCsv(6, "acc", "centerline")).toEqual(loadBundledPointCsv(17, "acc", "centerline"));
  });

  test("uses explicit ACC fallback only when AC Evo has no ideal line", () => {
    const identity = findTrackAssetIdentities("silverstone", "ac-evo")[0]!;
    expect(existsSync(bundledGeometryPath(identity, "centerline"))).toBe(false);
    expect(loadBundledPointCsv(identity.ordinal, "ac-evo", "centerline")?.length).toBeGreaterThan(20);
    expect(loadExtractedBoundary(identity.ordinal, "ac-evo")?.leftEdge.length).toBeGreaterThan(20);
  });

  test("loads venue-shared TUMFTM geometry by unique facts slug", () => {
    expect(loadSharedOutline("spa")?.length).toBeGreaterThan(20);
  });
});
