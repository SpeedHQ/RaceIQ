import { describe, expect, test } from "bun:test";
import { isNarrowViewport } from "../src/hooks/useNarrowViewport";

describe("desktop-width gate", () => {
  test("uses available width instead of the viewport's shortest edge", () => {
    expect(isNarrowViewport(1366)).toBe(false);
    expect(isNarrowViewport(700)).toBe(true);
  });
});
