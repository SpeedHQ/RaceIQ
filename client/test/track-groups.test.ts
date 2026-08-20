import { describe, expect, test } from "bun:test";
import type { TrackInfo } from "../src/components/track/types";
import { groupBaseTracks } from "../src/lib/track-groups";

function track(overrides: Partial<TrackInfo> & Pick<TrackInfo, "ordinal" | "name" | "variant">): TrackInfo {
  return {
    location: "Test location",
    country: "USA",
    lengthKm: 0,
    hasOutline: false,
    createdAt: null,
    ...overrides,
  };
}

describe("base track grouping", () => {
  test("groups layouts by venue and selects a main layout", () => {
    const groups = groupBaseTracks([
      track({ ordinal: 12, name: "Road America", variant: "Short Circuit", lengthKm: 3.5, hasOutline: true, lapCount: 2 }),
      track({ ordinal: 11, name: "Road America", variant: "Full Circuit", lengthKm: 6.5, hasOutline: true, lapCount: 3, baseImageUrl: "/satellite.webp" }),
      track({ ordinal: 20, name: "Watkins Glen", variant: "Grand Prix", lengthKm: 5.4, hasOutline: true, lapCount: 4 }),
    ]);

    expect(groups).toHaveLength(2);
    const roadAmerica = groups.find((group) => group.name === "Road America");
    expect(roadAmerica?.layouts.map((layout) => layout.ordinal)).toEqual([11, 12]);
    expect(roadAmerica?.primaryLayout.ordinal).toBe(11);
    expect(roadAmerica?.lapCount).toBe(5);
    expect(roadAmerica?.baseImageUrl).toBe("/satellite.webp");
    expect(roadAmerica?.hasMap).toBe(true);
  });
});
