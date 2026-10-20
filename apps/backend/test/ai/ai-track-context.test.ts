import { describe, test, expect } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import type { GameId } from "@raceiq/shared/games/ids";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { initServerGameAdapters } from "../../src/games/init";
import { tryGetServerGame } from "@raceiq/backend-core/games/registry";
import { resolveTrack } from "@raceiq/backend-core/tracks/info";
import { buildAnalystPrompt } from "@raceiq/backend-core/ai/analyst-prompt";

initGameAdapters();
initServerGameAdapters();

/** The AI prompts must use curated turn labels and per-game sector boundaries. */
function trackIdFor(gameId: GameId, slug: string): string | undefined {
  const adapter = tryGetServerGame(gameId);
  for (let id = 0; id < 600; id++) {
    const nativeTrackId = String(id);
    if (adapter?.getSharedTrackName?.(nativeTrackId) === slug) return nativeTrackId;
  }
  return undefined;
}

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "f1-2025", IsRaceOn: 1, TimestampMS: 0, DistanceTraveled: 0,
    CurrentLap: 0, LastLap: 0, BestLap: 0, LapNumber: 1, PositionX: 0,
    PositionZ: 0, Speed: 50, Fuel: 1.0, TireWearFL: 0, TireWearFR: 0,
    TireWearRL: 0, TireWearRR: 0, ...overrides,
  } as TelemetryPacket;
}

const lapPackets = (gameId: GameId) =>
  Array.from({ length: 120 }, (_, i) =>
    pkt({ gameId, TimestampMS: i * 500, DistanceTraveled: i * 58, CurrentLap: i * 0.5, Speed: 60 }),
  );

describe("resolveTrack", () => {
  test("returns the slug, segments with turn numbers, and sectors", () => {
    const track = resolveTrack("f1-2025", trackIdFor("f1-2025", "spa")!);
    expect(track.slug).toBe("spa");
    expect(track.sectors.s1End).toBeGreaterThan(0);
    expect(track.sectors.s2End).toBeGreaterThan(track.sectors.s1End);
    expect(track.segments.filter((s) => s.number !== undefined).length).toBeGreaterThan(5);
  });

  test("names come from the shared facts, fractions from the game", () => {
    const f1 = resolveTrack("f1-2025", trackIdFor("f1-2025", "spa")!);
    const acc = resolveTrack("acc", trackIdFor("acc", "spa")!);
    const f1First = f1.segments.find((s) => s.type === "corner");
    const accFirst = acc.segments.find((s) => s.type === "corner");
    expect(f1First?.name).toBe(accFirst?.name);
    expect(f1First?.startFrac).not.toBe(accFirst?.startFrac);
    expect(f1.sectors.s1End).not.toBe(acc.sectors.s1End);
  });

  test("both games resolve to one facts file", () => {
    const f1 = resolveTrack("f1-2025", trackIdFor("f1-2025", "spa")!);
    const acc = resolveTrack("acc", trackIdFor("acc", "spa")!);
    expect(f1.facts).toEqual(acc.facts);
    expect(f1.name).toBe(acc.name);
  });

  test("no game or no track ID degrades instead of throwing", () => {
    const noGame = resolveTrack(undefined, "1");
    expect(noGame.slug).toBeUndefined();
    expect(noGame.segments).toEqual([]);
    expect(noGame.facts).toBeNull();
    expect(noGame.sectors.s1End).toBeGreaterThan(0);
    const noTrack = resolveTrack("f1-2025", null);
    expect(noTrack.slug).toBeUndefined();
    expect(noTrack.segments).toEqual([]);
    expect(noTrack.outline).toBeNull();
  });
});

describe("analyst prompt carries the curated track data", () => {
  const trackId = trackIdFor("f1-2025", "spa")!;
  const track = resolveTrack("f1-2025", trackId);
  const prompt = buildAnalystPrompt(
    { lapNumber: 1, lapTime: 104.5, isValid: true, carId: "1", trackId, gameId: "f1-2025" },
    lapPackets("f1-2025"), [], "metric", "C", undefined, track.segments, undefined,
    "en", { times: [30.1, 42.4, 32.0], sectorStarts: [0, track.sectors.s1End, track.sectors.s2End] },
  );

  test("segment list labels corners with their turn numbers", () => {
    expect(prompt).toContain("--- Track Segments");
    expect(prompt).toContain("Eau Rouge/Raidillon (2-4)");
  });
  test("omits the Forza export for F1 prompts", () => {
    expect(prompt).not.toContain("=== Forza Motorsport Lap Export ===");
  });
  test("the corner whitelist uses those same labels", () => {
    expect(prompt.slice(prompt.indexOf("--- Valid Corner Labels"))).toContain("Eau Rouge/Raidillon (2-4)");
  });
  test("sector times are included with boundaries", () => {
    expect(prompt).toContain("--- Sector Times");
    expect(prompt).toContain("S1: 30.100s");
    expect(prompt).toContain("S2: 42.400s");
    expect(prompt).toContain("S3: 32.000s");
    expect(prompt).toContain("S1 ends at");
  });
  test("each sector names the corners it covers", () => {
    const block = prompt.slice(prompt.indexOf("--- Sector Times"), prompt.indexOf("--- Valid Corner Labels"));
    expect(block).toContain("covers");
    expect(block.split("\n").find((line) => line.startsWith("S1:")) ?? "").toContain("La Source");
  });
  test("omitting sectors omits the block", () => {
    const noSectors = buildAnalystPrompt(
      { lapNumber: 1, lapTime: 104.5, isValid: true, carId: "1", trackId, gameId: "f1-2025" },
      lapPackets("f1-2025"), [], "metric", "C", undefined, track.segments, undefined, "en",
    );
    expect(noSectors).not.toContain("--- Sector Times");
    expect(noSectors).toContain("--- Track Segments");
  });
});

test("analyst prompt preserves arbitrary native sector times and boundaries", () => {
  const trackId = trackIdFor("f1-2025", "spa")!;
  const track = resolveTrack("f1-2025", trackId);
  const prompt = buildAnalystPrompt(
    { lapNumber: 1, lapTime: 104.5, isValid: true, carId: "1", trackId, gameId: "f1-2025" },
    lapPackets("f1-2025"), [], "metric", "C", undefined, track.segments, undefined, "en",
    { times: [17.1, 18.2, 19.3, 20.4, 21.5, 22.6], sectorStarts: [0, 0.17, 0.34, 0.51, 0.68, 0.84] },
  );
  const block = prompt.slice(prompt.indexOf("--- Sector Times"), prompt.indexOf("--- Valid Corner Labels"));
  for (const [index, time] of [17.1, 18.2, 19.3, 20.4, 21.5, 22.6].entries()) {
    expect(block).toContain(`S${index + 1}: ${time.toFixed(3)}s`);
  }
  for (const boundary of [17, 34, 51, 68, 84]) expect(block).toContain(`${boundary.toFixed(1)}%`);
});
