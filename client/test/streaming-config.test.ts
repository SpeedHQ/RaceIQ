import { describe, expect, it } from "bun:test";
import { buildOverlayUrl, parseOverlayConfig } from "../src/lib/streaming-config";

describe("streaming config", () => {
  it("defaults malformed values and discards unknown keys", () => {
    expect(parseOverlayConfig({ widget: "other", unit: "km", extra: "x" })).toEqual({ widget: "driving", unit: "metric" });
    expect(parseOverlayConfig({ widget: "nearby", unit: "imperial", extra: "x" })).toEqual({ widget: "nearby", unit: "imperial" });
  });
  it("builds origin-preserving independently configured source URLs", () => {
    expect(buildOverlayUrl("https://raceiq.local:8443", { widget: "timing", unit: "imperial" }))
      .toBe("https://raceiq.local:8443/overlay?widget=timing&unit=imperial");
  });
});
