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

  test("resolves exact LMU catalog string IDs to layout display names", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/bahrainwec" })).toBe("Bahrain International Circuit");
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/bahrainwec_paddock" })).toBe("Bahrain Paddock Circuit");
  });

  test("keeps readable ambiguous LMU name and does not infer opaque ID prefixes", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: "Circuit de Spa-Francorchamps" })).toBe("Circuit de Spa-Francorchamps");
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/ba" })).toBeUndefined();
  });
  
  test("keeps unknown IDs and missing game identity unresolved", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: null })).toBeUndefined();
    expect(resolveTrackDisplayName(null, { trackId: "3" }, names)).toBeUndefined();
  });
});
