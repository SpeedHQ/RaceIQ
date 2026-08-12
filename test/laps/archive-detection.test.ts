import { zipSync } from "fflate";
import { describe, expect, test } from "bun:test";
import { detectLapsZip } from "../../server/laps/archive";

describe("detectLapsZip", () => {
  test("rejects arbitrary ZIP content as a RaceIQ archive", () => {
    const result = detectLapsZip(zipSync({ "readme.txt": new TextEncoder().encode("not telemetry") }));

    expect(result.isRaceIqArchive).toBe(false);
    expect(result.captureCount).toBe(0);
    expect(result.gameIds).toEqual([]);
  });
});
