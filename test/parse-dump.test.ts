import { describe, test, expect } from "bun:test";
import { parseDump } from "./helpers/parse-dump";

describe("parseDump", () => {
  test("returns empty array for a missing dump file (UDP game)", async () => {
    const laps = await parseDump("f1-2025", "/nonexistent/dump.bin");
    expect(laps).toEqual([]);
  });

  test("returns empty array for a missing dump file (ACC)", async () => {
    const laps = await parseDump("acc", "/nonexistent/dump.bin");
    expect(laps).toEqual([]);
  });
});
