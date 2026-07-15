import { describe, test, expect } from "bun:test";
import type { TelemetryPacket, GameId } from "../shared/types";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { tryGetServerGame } from "../server/games/registry";
import { resolveTrackContext } from "../server/ai/track-context";
import { buildAnalystPrompt } from "../server/ai/analyst-prompt";

initGameAdapters();
initServerGameAdapters();

/**
 * The AI prompts must receive the curated track data from #84 — named segments
 * with their official turn numbers, and the game's own sector boundaries.
 *
 * Both matter. Without `numbers` the model sees "Eau Rouge/Raidillon" but not
 * which turns it is, and the label disagrees with the track map. Without the
 * per-game set it gets another game's lap fractions, because each game's
 * centerline is sampled differently.
 */

function ordinalFor(gameId: GameId, slug: string): number | undefined {
  const a = tryGetServerGame(gameId);
  for (let o = 0; o < 600; o++) if (a?.getSharedTrackName?.(o) === slug) return o;
  return undefined;
}

function pkt(overrides: Partial<TelemetryPacket>): TelemetryPacket {
  return {
    gameId: "f1-2025",
    IsRaceOn: 1,
    TimestampMS: 0,
    DistanceTraveled: 0,
    CurrentLap: 0,
    LastLap: 0,
    BestLap: 0,
    LapNumber: 1,
    PositionX: 0,
    PositionZ: 0,
    Speed: 50,
    Fuel: 1.0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    ...overrides,
  } as TelemetryPacket;
}

const lapPackets = (gameId: GameId) =>
  Array.from({ length: 120 }, (_, i) =>
    pkt({ gameId, TimestampMS: i * 500, DistanceTraveled: i * 58, CurrentLap: i * 0.5, Speed: 60 }),
  );

describe("resolveTrackContext", () => {
  test("returns the slug, segments with turn numbers, and sectors", () => {
    const ord = ordinalFor("f1-2025", "spa")!;
    const ctx = resolveTrackContext("f1-2025", ord);
    expect(ctx.slug).toBe("spa");
    expect(ctx.sectors?.s1End).toBeGreaterThan(0);
    expect(ctx.sectors?.s2End).toBeGreaterThan(ctx.sectors!.s1End);
    const withNumbers = ctx.segments?.filter((s) => s.numbers?.length) ?? [];
    expect(withNumbers.length).toBeGreaterThan(5);
  });

  test("prefers the game's own segments over the shared set", () => {
    // Spa is curated for both, and their centerlines differ — so the same
    // corner must not land on the same lap fraction for both games. This is
    // the regression that fed ACC laps F1's boundaries.
    const f1 = resolveTrackContext("f1-2025", ordinalFor("f1-2025", "spa")!);
    const acc = resolveTrackContext("acc", ordinalFor("acc", "spa")!);
    const f1First = f1.segments?.find((s) => s.type === "corner");
    const accFirst = acc.segments?.find((s) => s.type === "corner");
    expect(f1First?.name).toBe(accFirst?.name); // same corner...
    expect(f1First?.startFrac).not.toBe(accFirst?.startFrac); // ...different geometry
    expect(f1.sectors?.s1End).not.toBe(acc.sectors?.s1End);
  });

  test("no game or no ordinal yields an empty context, not a throw", () => {
    expect(resolveTrackContext(undefined, 1)).toEqual({});
    expect(resolveTrackContext("f1-2025", null)).toEqual({});
  });
});

describe("analyst prompt carries the curated track data", () => {
  const ord = ordinalFor("f1-2025", "spa")!;
  const ctx = resolveTrackContext("f1-2025", ord);
  const prompt = buildAnalystPrompt(
    { lapNumber: 1, lapTime: 104.5, isValid: true, carOrdinal: 1, trackOrdinal: ord, gameId: "f1-2025" },
    lapPackets("f1-2025"),
    [],
    "metric",
    "C",
    undefined,
    ctx.segments,
    undefined,
    "en",
    { times: { s1: 30.1, s2: 42.4, s3: 32.0 }, s1End: ctx.sectors!.s1End, s2End: ctx.sectors!.s2End },
  );

  test("segment list labels corners with their turn numbers", () => {
    expect(prompt).toContain("--- Track Segments");
    // The same string the track map renders — not a bare "Eau Rouge/Raidillon".
    expect(prompt).toContain("Eau Rouge/Raidillon (2-4)");
  });

  test("the corner whitelist uses those same labels", () => {
    const block = prompt.slice(prompt.indexOf("--- Valid Corner Labels"));
    expect(block).toContain("Eau Rouge/Raidillon (2-4)");
  });

  test("sector times are included, with the boundaries they were split on", () => {
    expect(prompt).toContain("--- Sector Times");
    expect(prompt).toContain("S1: 30.100s");
    expect(prompt).toContain("S2: 42.400s");
    expect(prompt).toContain("S3: 32.000s");
    expect(prompt).toContain("S1 ends at");
  });

  test("each sector names the corners it covers", () => {
    const block = prompt.slice(prompt.indexOf("--- Sector Times"), prompt.indexOf("--- Valid Corner Labels"));
    expect(block).toContain("covers");
    // La Source is the first corner of the lap, so it belongs to sector 1.
    const s1Line = block.split("\n").find((l) => l.startsWith("S1:")) ?? "";
    expect(s1Line).toContain("La Source");
  });

  test("omitting sectors omits the block rather than emitting an empty one", () => {
    const noSectors = buildAnalystPrompt(
      { lapNumber: 1, lapTime: 104.5, isValid: true, carOrdinal: 1, trackOrdinal: ord, gameId: "f1-2025" },
      lapPackets("f1-2025"),
      [],
      "metric",
      "C",
      undefined,
      ctx.segments,
      undefined,
      "en",
    );
    expect(noSectors).not.toContain("--- Sector Times");
    expect(noSectors).toContain("--- Track Segments");
  });
});
