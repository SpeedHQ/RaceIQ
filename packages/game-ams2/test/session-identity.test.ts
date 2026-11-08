import { describe, expect, test } from "bun:test";
import { hasAMS2CarIdentity, hasAMS2TrackIdentity, registerAMS2Identity } from "@raceiq/game-ams2-metadata/index";

describe("AMS2 catalog identity", () => {
  test("accepts catalog and newly discovered identities", () => {
    expect(hasAMS2CarIdentity("325487790")).toBe(true);
    expect(hasAMS2TrackIdentity("165370945")).toBe(true);
    registerAMS2Identity("test-session-car", "Car", "test-session-track", "Track");
    expect(hasAMS2CarIdentity("test-session-car")).toBe(true);
    expect(hasAMS2TrackIdentity("test-session-track")).toBe(true);
  });

  test("rejects missing identities", () => {
    expect(hasAMS2CarIdentity("not-a-catalog-identity")).toBe(false);
    expect(hasAMS2TrackIdentity("not-a-catalog-identity")).toBe(false);
  });
});
