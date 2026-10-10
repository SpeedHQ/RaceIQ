import { describe, expect, test } from "bun:test";
import { dashboardTrackIdentity } from "@raceiq/shared/racing/sessions/dashboard";
import { resolveTrackDisplayName } from "../src/lib/track-display-name";

describe("dashboard track display names", () => {
  test("decodes native string identities instead of displaying serialized keys", () => {
    expect(resolveTrackDisplayName("lmu", { trackIdentity: dashboardTrackIdentity("lmu", "Circuit de Spa-Francorchamps", null) })).toBe("Circuit de Spa-Francorchamps");
  });
  test("resolves native numeric identities with game-scoped server names", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: dashboardTrackIdentity("acc", 5, null) }, { "acc:5": "Monza", "f1-2025:5": "Monaco" })).toBe("Monza");
  });
  test("accepts reference reducer identities and preserves unknown tracks", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: "n:19" }, { "acc:19": "Spa" })).toBe("Spa");
    expect(resolveTrackDisplayName("lmu", { trackIdentity: "s:Circuit de Spa-Francorchamps" })).toBe("Circuit de Spa-Francorchamps");
    expect(resolveTrackDisplayName("acc", { trackIdentity: "track:unknown", trackOrdinal: -1 })).toBeUndefined();
  });
  test("does not resolve serialized identities from another game", () => {
    expect(resolveTrackDisplayName("acc", { trackIdentity: dashboardTrackIdentity("f1-2025", 5, null) }, { "acc:5": "Monza" })).toBeUndefined();
  });
});
