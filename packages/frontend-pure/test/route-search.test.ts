import { describe, expect, test } from "bun:test";
import { parseOptionalIdentityKey, parseOptionalNumber } from "../src/route-search";

describe("route search parsers", () => {
  test("parses finite optional numbers and rejects blank or non-finite values", () => {
    expect(parseOptionalNumber(12)).toBe(12);
    expect(parseOptionalNumber(" 12 ")).toBe(12);
    for (const value of ["", "  ", "nope", Infinity, NaN, null, undefined, true]) {
      expect(parseOptionalNumber(value)).toBeUndefined();
    }
  });

  test("normalizes numeric identities while preserving canonical string keys", () => {
    expect(parseOptionalIdentityKey(42)).toBe("42");
    expect(parseOptionalIdentityKey("0042")).toBe("0042");
    expect(parseOptionalIdentityKey(["Circuit Park", "Grand Prix"])).toBe(JSON.stringify(["Circuit Park", "Grand Prix"]));
    for (const value of ["", Infinity, NaN, null, undefined, true, ["venue"], ["venue", ""], ["venue", 1]]) {
      expect(parseOptionalIdentityKey(value)).toBeUndefined();
    }
  });
});
