import { describe, test, expect } from "bun:test";
import { parseDump } from "./helpers/parse-dump";

describe("parseDump", () => {
  test("returns empty result for a missing dump file (UDP game)", async () => {
    const result = await parseDump("f1-2025", "/nonexistent/dump.bin");
    expect(result.laps).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.carModel).toBe(null);
    expect(result.trackName).toBe(null);
  });

  test("returns empty result for a missing dump file (ACC)", async () => {
    const result = await parseDump("acc", "/nonexistent/dump.bin");
    expect(result.laps).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.carModel).toBe(null);
    expect(result.trackName).toBe(null);
  });
});
