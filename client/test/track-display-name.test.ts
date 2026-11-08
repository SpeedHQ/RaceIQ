import { describe, expect, test } from "bun:test";
import { resolveTrackDisplayName } from "../src/lib/track-display-name";

describe("dashboard track display names", () => {
  test("keeps readable LMU identities unchanged", () => {
    expect(resolveTrackDisplayName("lmu", { trackIdentity: "Circuit de Spa-Francorchamps" })).toBe("Circuit de Spa-Francorchamps");
  });
  test("resolves exact string identities with game-scoped server names", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: "track-5" }, { "acc:track-5": "Monza", "f1-2025:track-5": "Monaco" })).toBe("Monza");
  });
  test("accepts raw string IDs and excludes invalid IDs", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: "track-19" }, { "acc:track-19": "Spa" })).toBe("Spa");
    expect(resolveTrackDisplayName("acc", { trackIdentity: "" })).toBeUndefined();
    expect(resolveTrackDisplayName("acc", { trackIdentity: "-1" })).toBeUndefined();
  });
  test("does not use another game's name for the same ID", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: "track-5" }, { "f1-2025:track-5": "Monaco" })).toBeUndefined();
  });
  test("preserves native JSON venue-layout IDs without decoding them as dashboard keys", () => {
    const trackId = JSON.stringify(["Nürburgring", "Tourist"]);
    expect(resolveTrackDisplayName("ac-evo", { trackIdentity: trackId }, { [`ac-evo:${trackId}`]: "Nürburgring Tourist" })).toBe("Nürburgring Tourist");
  });
});
