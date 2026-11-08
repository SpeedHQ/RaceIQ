import { describe, expect, test } from "bun:test";
import { isKnownSessionIdentity } from "../src/components/analyse/session-identity";

const cars = new Set(["33"]);
const tracks = new Set(["22", "8", "19"]);

describe("session identity catalog recognition", () => {
  test("recognizes native ACC identities, including tracks with ambiguous legacy IDs", () => {
    expect(isKnownSessionIdentity("acc", "porsche_992_gt3_r", "kyalami", cars, tracks)).toBe(true);
    expect(isKnownSessionIdentity("acc", "porsche_992_gt3_r", "barcelona", cars, tracks)).toBe(true);
    expect(isKnownSessionIdentity("acc", "33", "22", cars, tracks)).toBe(true);
    expect(isKnownSessionIdentity("acc", "33", "kyalami", cars, tracks)).toBe(true);
  });

  test("rejects unknown and fuzzy identities without changing other games", () => {
    expect(isKnownSessionIdentity("acc", "porsche_992_gt3", "kyalami", cars, tracks)).toBe(false);
    expect(isKnownSessionIdentity("acc", "porsche_992_gt3_r", "kyalami_gp", cars, tracks)).toBe(false);
    expect(isKnownSessionIdentity("ac-evo", "porsche_992_gt3_r", "kyalami", cars, tracks)).toBe(false);
    expect(isKnownSessionIdentity("ac-evo", "33", "22", cars, tracks)).toBe(true);
  });
});
