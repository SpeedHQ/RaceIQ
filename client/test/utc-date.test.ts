import { describe, expect, test } from "bun:test";
import { parseUtcTimestamp } from "../src/lib/utc-date";

describe("UTC timestamp parsing", () => {
  test("treats SQLite datetime text as UTC", () => {
    expect(parseUtcTimestamp("2026-09-29 12:34:56").toISOString()).toBe("2026-09-29T12:34:56.000Z");
  });

  test("preserves explicit offsets", () => {
    expect(parseUtcTimestamp("2026-09-29T14:34:56+02:00").toISOString()).toBe("2026-09-29T12:34:56.000Z");
    expect(parseUtcTimestamp("2026-09-29T12:34:56Z").toISOString()).toBe("2026-09-29T12:34:56.000Z");
  });
});
