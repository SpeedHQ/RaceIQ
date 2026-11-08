import { describe, expect, test } from "bun:test";
import { resolveTrackDisplayName } from "client/src/lib/track-display-name";

const names = {
  "fm-2023:3": "Forza track three",
  "f1-2025:3": "F1 track three",
};

describe("resolveTrackDisplayName", () => {
  test("keeps canonical track-name lookup scoped to game", () => {
    expect(resolveTrackDisplayName("fm-2023", { trackId: "3" }, names)).toBe("Forza track three");
    expect(resolveTrackDisplayName("f1-2025", { trackId: "3" }, names)).toBe("F1 track three");
  });

  
  test("keeps unknown IDs and missing game identity unresolved", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: null })).toBeUndefined();
    expect(resolveTrackDisplayName(null, { trackId: "3" }, names)).toBeUndefined();
  });
});
