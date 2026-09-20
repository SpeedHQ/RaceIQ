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

  test("recognizes manifest-backed MoTeC source members", () => {
    const member = "acc-barcelona-session42.motec.zip";
    const nested = zipSync({ "session.ld": new Uint8Array([1]), "session.ldx": new Uint8Array([2]) });
    const manifest = {
      version: 4,
      exportedAt: "2026-01-01T00:00:00.000Z",
      entries: [{
        file: member,
        gameId: "acc",
        sessionId: 42,
        carOrdinal: 1,
        trackOrdinal: 2,
        carName: "Car",
        trackName: "Track",
        createdAt: "2026-01-01",
        laps: [],
      }],
    };
    const result = detectLapsZip(zipSync({
      [member]: nested,
      "manifest.json": new TextEncoder().encode(JSON.stringify(manifest)),
    }));

    expect(result.isRaceIqArchive).toBe(true);
    expect(result.captureCount).toBe(1);
    expect(result.gameIds).toEqual(["acc"]);
  });
});
