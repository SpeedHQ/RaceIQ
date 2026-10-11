import { zipSync } from "fflate";
import { describe, expect, test } from "bun:test";
import { detectLapsZip } from "../../src/laps/archive";
import { getAllAcEvoCars } from "@raceiq/game-ac-evo-metadata/racing/cars/ac-evo";

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
        carId: "1",
        trackId: "2",
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

  test.each([
    ["valid", false, false],
    ["missing", true, false],
    ["unknown", true, false],
    ["unsupported game", true, true],
  ])("reports %s MoTeC identities for manual assignment", (kind, needsAssignment, unsupported) => {
    const file = "ac-evo-session42.motec.zip";
    const carId = getAllAcEvoCars()[0]!.id;
    const entry = {
      file, gameId: kind === "unsupported game" ? "unsupported" : "ac-evo",
      ...(kind === "missing" ? {} : { carId: kind === "unknown" ? "unknown-car" : carId }),
      trackId: '["Brands Hatch","GP"]',
    };
    const result = detectLapsZip(zipSync({
      [file]: zipSync({ "source.ld": new Uint8Array([1]) }),
      "manifest.json": new TextEncoder().encode(JSON.stringify({ version: 4, entries: [entry] })),
    }));
    expect(result.missingMotecIdentities).toEqual(needsAssignment ? [{
      file,
      gameId: unsupported ? null : "ac-evo",
      carId: null,
      trackId: unsupported ? null : '["Brands Hatch","GP"]',
      unsupported,
    }] : []);
  });
});
