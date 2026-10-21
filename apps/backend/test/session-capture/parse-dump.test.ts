import { f1RecordingSupport } from "@raceiq/game-f1-2025/test-support/recordings";
import { accRecordingSupport } from "@raceiq/game-acc/test-support/recordings";
import { describe, test, expect } from "bun:test";
import { parseDump } from "@raceiq/backend-core/test-support/recordings/parse-dump";

describe("parseDump", () => {
  test("returns empty result for a missing dump file (UDP game)", async () => {
    const result = await parseDump(f1RecordingSupport, "/nonexistent/dump.bin");
    expect(result.laps).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.carModel).toBe(null);
    expect(result.trackName).toBe(null);
  });

  test("returns empty result for a missing dump file (ACC)", async () => {
    const result = await parseDump(accRecordingSupport, "/nonexistent/dump.bin");
    expect(result.laps).toEqual([]);
    expect(result.sessions).toEqual([]);
    expect(result.carModel).toBe(null);
    expect(result.trackName).toBe(null);
  });
});
