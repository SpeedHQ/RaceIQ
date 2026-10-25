import { describe, expect, test } from "bun:test";
import { resolveTrackDisplayName } from "client/src/lib/track-display-name";

describe("resolveTrackDisplayName for LMU", () => {
  test("resolves exact LMU catalog string IDs to layout display names", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/bahrainwec" })).toBe("Bahrain International Circuit");
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/bahrainwec_paddock" })).toBe("Bahrain Paddock Circuit");
  });
  test("keeps readable ambiguous name and does not infer opaque ID prefixes", () => {
    expect(resolveTrackDisplayName("lmu", { trackId: "Circuit de Spa-Francorchamps" })).toBe("Circuit de Spa-Francorchamps");
    expect(resolveTrackDisplayName("lmu", { trackId: "bahrainwec_2023/ba" })).toBeUndefined();
  });
});
