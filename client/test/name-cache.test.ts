import { describe, expect, test } from "bun:test";
import { mergeNameCache } from "../src/lib/name-cache";

describe("mergeNameCache", () => {
  test("returns same cache when resolved names are already present", () => {
    const cache = { 101: "Silverstone" };
    const result = mergeNameCache(cache, { "101": "Silverstone" });

    expect(result).toBe(cache);
  });

  test("adds newly resolved names", () => {
    const cache = { 101: "Silverstone" };
    const result = mergeNameCache(cache, { "101": "Silverstone", "102": "Monza" });

    expect(result).toEqual({ 101: "Silverstone", 102: "Monza" });
    expect(result).not.toBe(cache);
  });
});
