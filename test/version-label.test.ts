import { describe, expect, test } from "bun:test";
import { computeChildLabel, nextFreeLabel } from "../server/ai/version-label";

describe("computeChildLabel", () => {
  test("first child of mainline increments last segment", () => {
    expect(computeChildLabel("v1", 0)).toBe("v2");
    expect(computeChildLabel("v2", 0)).toBe("v3");
  });
  test("first child of a branch increments the branch's last segment", () => {
    expect(computeChildLabel("v1.1", 0)).toBe("v1.2");
    expect(computeChildLabel("v1.2.3", 0)).toBe("v1.2.4");
  });
  test("second+ child forks by appending a nested segment", () => {
    expect(computeChildLabel("v1", 1)).toBe("v1.1");
    expect(computeChildLabel("v1", 2)).toBe("v1.2");
    expect(computeChildLabel("v2", 1)).toBe("v2.1");
  });
  test("non-numeric base label ('base') forks/continues predictably", () => {
    // 'base' has no trailing number → first child starts the numbered line at v1.
    expect(computeChildLabel("base", 0)).toBe("v1");
    expect(computeChildLabel("base", 1)).toBe("base.1");
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
