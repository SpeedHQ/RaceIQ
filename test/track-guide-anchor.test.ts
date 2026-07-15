import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { buildTrackGuideContext, guideCornerLabels, getAvailableTrackGuides } from "../server/ai/track-guides";

initGameAdapters();
initServerGameAdapters();

/**
 * Track meta (shared/tracks/meta/<id>.json) owns corner naming; the expert
 * guides own technique. They join on official turn numbers.
 *
 * These tests are the checksum for that join. A guide entry anchored to a turn
 * the circuit doesn't have is a defect — the guide would silently coach a
 * corner that doesn't exist, and (worse) the analyst prompt would whitelist its
 * name, teaching the model that name is legitimate.
 */

const META_DIR = resolve(import.meta.dir, "../shared/tracks/meta");

type Seg = { type: string; name?: string; numbers?: number[] };
type Meta = { segments?: Seg[]; games?: Record<string, { segments?: Seg[] }> };

function loadMeta(slug: string): Meta | null {
  const p = resolve(META_DIR, `${slug}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as Meta;
}

/** Every turn number meta knows about for a slug, across shared + per-game sets. */
function knownTurns(meta: Meta): Set<number> {
  const out = new Set<number>();
  const add = (segs?: Seg[]) => (segs ?? []).forEach((s) => (s.numbers ?? []).forEach((n) => out.add(n)));
  add(meta.segments);
  for (const g of Object.values(meta.games ?? {})) add(g.segments);
  return out;
}

// Parsed from source: the guides array isn't exported, and the anchors are the
// thing under test, so read them the way a reviewer would.
function guideAnchors(): { slug: string; name: string; numbers: number[] }[] {
  const src = readFileSync(resolve(import.meta.dir, "../server/ai/track-guides.ts"), "utf8");
  const out: { slug: string; name: string; numbers: number[] }[] = [];
  let slug = "";
  for (const line of src.split("\n")) {
    const id = line.match(/^\s*id: "([a-z0-9-]+)"/);
    if (id) {
      slug = id[1];
      continue;
    }
    const c = line.match(/^\s*\{ name: "([^"]+)", numbers: \[([0-9, ]*)\]/);
    if (c && slug) {
      out.push({
        slug,
        name: c[1],
        numbers: c[2].split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n)),
      });
    }
  }
  return out;
}

describe("track guide turn-number anchors", () => {
  const anchors = guideAnchors();

  test("the guides carry anchors at all", () => {
    expect(anchors.length).toBeGreaterThan(200);
  });

  test("every anchored turn exists in that track's meta", () => {
    const offenders: string[] = [];
    for (const a of anchors) {
      const meta = loadMeta(a.slug);
      if (!meta) {
        offenders.push(`${a.slug} :: ${a.name} — anchored but no meta file`);
        continue;
      }
      const turns = knownTurns(meta);
      const missing = a.numbers.filter((n) => !turns.has(n));
      if (missing.length) {
        offenders.push(`${a.slug} :: ${a.name} — meta has no turn ${missing.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("anchors are non-empty and ascending", () => {
    const bad = anchors.filter(
      (a) => a.numbers.length === 0 || a.numbers.some((n, i) => i > 0 && n <= a.numbers[i - 1]),
    );
    expect(bad.map((b) => `${b.slug} :: ${b.name}`)).toEqual([]);
  });
});

describe("guide corner naming defers to meta", () => {
  test("Monaco: guide's own names give way to meta's", () => {
    // The guide says "Swimming Pool" and "Grand Hotel Hairpin"; meta (and so
    // the track map, and the prompt's corner whitelist) say Piscine / Fairmont.
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    expect(out).toContain("Piscine (14-15)");
    expect(out).toContain("Fairmont Hairpin (6)");
    expect(out).not.toContain("Swimming Pool");
    expect(out).not.toContain("Grand Hotel Hairpin");
  });

  test("Spa: accent/article drift resolves to the meta spelling", () => {
    const out = buildTrackGuideContext("Spa", { slug: "spa", gameId: "f1-2025" });
    // Guide spells it "Fagnes"; meta spells it "Les Fagnes".
    expect(out).toContain("Les Fagnes");
  });

  test("priority corners use the same labels as the corner list", () => {
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const priority = out.split("Priority corners (most impactful on lap time): ")[1]?.split("\n")[0] ?? "";
    expect(priority).toContain("Fairmont Hairpin (6)");
    // A priority entry naming a corner the list above labels differently would
    // hand the model two names for one corner.
    for (const label of priority.split(", ")) {
      expect(out).toContain(`• ${label} [`);
    }
  });

  test("without a slug, falls back to the guide's own names (no crash)", () => {
    const out = buildTrackGuideContext("Monaco");
    expect(out).toContain("Expert Track Guide");
    expect(out).toContain("Swimming Pool");
  });

  test("guideCornerLabels matches the labels the context block emits", () => {
    const labels = guideCornerLabels("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) expect(out).toContain(`• ${l} [`);
  });

  test("unknown track yields no guide", () => {
    expect(buildTrackGuideContext("Wibble Speedway")).toBe("");
    expect(guideCornerLabels("nonexistent-track")).toEqual([]);
  });

  test("meta merging two corners into one segment emits one bullet", () => {
    // Monaco meta has a single "Rascasse / Antony Noghès" segment; the guide
    // coaches the two separately. Printing both would read as two corners.
    const out = buildTrackGuideContext("Monaco", { slug: "monaco", gameId: "f1-2025" });
    const occurrences = out.split("• Rascasse / Antony Noghès (18-19) [").length - 1;
    expect(occurrences).toBe(1);
  });

  test("every guide id resolves", () => {
    expect(getAvailableTrackGuides().length).toBeGreaterThan(50);
  });
});
