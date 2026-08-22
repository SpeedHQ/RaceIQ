import { describe, test, expect } from "bun:test";
import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { GameId } from "../../shared/games/ids";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { tryGetServerGame } from "../../server/games/registry";
import { resolveTrack } from "../../server/tracks/info";
import { buildAnalystPrompt } from "../../server/ai/analyst-prompt";

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

function sample(index: number, values: SemanticTelemetrySample["values"]): SemanticTelemetrySample {
  return {
    sequence: String(index),
    observedAtMs: index * 500,
    values: {
      "motion.position-x": 0,
      "motion.position-z": 0,
      "motion.speed": 50,
      "fuel.fuel": 1,
      "tire.temperature.average": [0, 0, 0, 0],
      "tires.tire-wear": [0, 0, 0, 0],
      ...values,
    },
  };
}

const lapSamples = () =>
  Array.from({ length: 120 }, (_, index) =>
    sample(index, {
      "timing.distance-traveled": index * 58,
      "timing.current-lap": index * 0.5,
      "motion.speed": 60,
    }),
  );

describe("resolveTrack", () => {
  test("returns the slug, segments with turn numbers, and sectors", () => {
    const ord = ordinalFor("f1-2025", "spa")!;
    const track = resolveTrack("f1-2025", ord);
    expect(track.slug).toBe("spa");
    expect(track.sectors.s1End).toBeGreaterThan(0);
    expect(track.sectors.s2End).toBeGreaterThan(track.sectors.s1End);
    expect(track.segments.filter((s) => s.number !== undefined).length).toBeGreaterThan(5);
  });

  test("names come from the shared facts, fractions from the game", () => {
    // Spa is curated for both, and their centerlines differ. The corner is the
    // same fact for both games, so it must carry the same name — but it must
    // not land on the same lap fraction. This is the regression that fed ACC
    // laps F1's boundaries.
    const f1 = resolveTrack("f1-2025", ordinalFor("f1-2025", "spa")!);
    const acc = resolveTrack("acc", ordinalFor("acc", "spa")!);
    const f1First = f1.segments.find((s) => s.type === "corner");
    const accFirst = acc.segments.find((s) => s.type === "corner");
    expect(f1First?.name).toBe(accFirst?.name); // same corner...
    expect(f1First?.startFrac).not.toBe(accFirst?.startFrac); // ...different geometry
    expect(f1.sectors.s1End).not.toBe(acc.sectors.s1End);
  });

  test("both games resolve to one facts file", () => {
    const f1 = resolveTrack("f1-2025", ordinalFor("f1-2025", "spa")!);
    const acc = resolveTrack("acc", ordinalFor("acc", "spa")!);
    expect(f1.facts).toEqual(acc.facts);
    expect(f1.name).toBe(acc.name);
  });

  test("no game or no ordinal degrades instead of throwing", () => {
    const noGame = resolveTrack(undefined, 1);
    expect(noGame.slug).toBeUndefined();
    expect(noGame.segments).toEqual([]);
    expect(noGame.facts).toBeNull();
    // Sectors always resolve, so callers never need their own default.
    expect(noGame.sectors.s1End).toBeGreaterThan(0);

    const noOrdinal = resolveTrack("f1-2025", null);
    expect(noOrdinal.slug).toBeUndefined();
    expect(noOrdinal.segments).toEqual([]);
    expect(noOrdinal.outline).toBeNull();
  });
});

describe("analyst prompt carries the curated track data", () => {
  const ord = ordinalFor("f1-2025", "spa")!;
  const track = resolveTrack("f1-2025", ord);
  const prompt = buildAnalystPrompt(
    { lapNumber: 1, lapTime: 104.5, isValid: true, carOrdinal: 1, trackOrdinal: ord, gameId: "f1-2025" },
    lapSamples(),
    [],
    "metric",
    "C",
    undefined,
    track.segments,
    undefined,
    "en",
    { times: [30.1, 42.4, 32.0], sectorStarts: [0, track.sectors.s1End, track.sectors.s2End] },
  );

  test("segment list labels corners with their turn numbers", () => {
    expect(prompt).toContain("--- Track Segments");
    // The same string the track map renders — not a bare "Eau Rouge/Raidillon".
    expect(prompt).toContain("Eau Rouge/Raidillon (2-4)");
  });
  test("omits the Forza export for F1 prompts", () => {
    expect(prompt).not.toContain("=== Forza Motorsport Lap Export ===");
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
      lapSamples(),
      [],
      "metric",
      "C",
      undefined,
      track.segments,
      undefined,
      "en",
    );
    expect(noSectors).not.toContain("--- Sector Times");
    expect(noSectors).toContain("--- Track Segments");
  });
});

test("analyst prompt preserves arbitrary native sector times and boundaries", () => {
  const ord = ordinalFor("f1-2025", "spa")!;
  const track = resolveTrack("f1-2025", ord);
  const prompt = buildAnalystPrompt(
    { lapNumber: 1, lapTime: 104.5, isValid: true, carOrdinal: 1, trackOrdinal: ord, gameId: "f1-2025" },
    lapSamples(),
    [],
    "metric",
    "C",
    undefined,
    track.segments,
    undefined,
    "en",
    {
      times: [17.1, 18.2, 19.3, 20.4, 21.5, 22.6],
      sectorStarts: [0, 0.17, 0.34, 0.51, 0.68, 0.84],
    },
  );
  const block = prompt.slice(prompt.indexOf("--- Sector Times"), prompt.indexOf("--- Valid Corner Labels"));
  for (const [index, time] of [17.1, 18.2, 19.3, 20.4, 21.5, 22.6].entries()) {
    expect(block).toContain(`S${index + 1}: ${time.toFixed(3)}s`);
  }
  for (const boundary of [17, 34, 51, 68, 84]) {
    expect(block).toContain(`${boundary.toFixed(1)}%`);
  }
});
