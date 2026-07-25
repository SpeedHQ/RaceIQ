import { describe, expect, test } from "bun:test";
import { computeChildLabel, nextFreeLabel } from "../server/ai/version-label";

describe("computeChildLabel", () => {
  test("every child nests under the parent in creation order", () => {
    expect(computeChildLabel("v1", 0)).toBe("v1.1");
    expect(computeChildLabel("v1", 1)).toBe("v1.2");
    expect(computeChildLabel("v1", 2)).toBe("v1.3");
    expect(computeChildLabel("v2", 0)).toBe("v2.1");
    expect(computeChildLabel("v1.2", 0)).toBe("v1.2.1");
  });
  test("non-numeric base label ('base') numbers children at top level", () => {
    // 'base' has no trailing number → children start the numbered line at v1, v2, …
    expect(computeChildLabel("base", 0)).toBe("v1");
    expect(computeChildLabel("base", 1)).toBe("v2");
  });
});

describe("nextFreeLabel", () => {
  test("returns candidate when free", () => {
    expect(nextFreeLabel("v1.2", new Set(["v1", "v2"]))).toBe("v1.2");
  });
  test("bumps last segment on collision", () => {
    expect(nextFreeLabel("v1.2", new Set(["v1.2", "v1.3"]))).toBe("v1.4");
  });
});
