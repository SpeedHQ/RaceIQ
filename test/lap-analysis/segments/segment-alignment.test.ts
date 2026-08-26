import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectCornerRegions, type CornerRegion } from "../../../shared/racing/tracks/curation/segment-align-detect";
import { alignSegments } from "../../../shared/racing/tracks/curation/segment-align-match";
import { validateFacts } from "../../../shared/racing/tracks/curation/segment-align-validate";
import { TrackFactsSchema, type TrackFacts } from "../../../shared/racing/tracks/facts";

/** Identity fields alignment never reads — every fixture shares them. */
const FACTS = { slug: "test", track: "test", layout: "full", layoutName: "Full", name: "Test" };

function region(startFrac: number, endFrac: number, direction: "left" | "right"): CornerRegion {
  return {
    startFrac,
    endFrac,
    apexFrac: (startFrac + endFrac) / 2,
    direction,
    peakKappa: 0.02,
    lengthM: (endFrac - startFrac) * 5000,
    turnRad: 0.5,
  };
}

describe("alignSegments", () => {
  test("exact 1:1 alignment names every corner", () => {
    const detected = [region(0.1, 0.15, "right"), region(0.4, 0.45, "left"), region(0.8, 0.85, "right")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Second", direction: "left" },
        { number: 3, name: "Third", direction: "right" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.cost).toBe(0);
    expect(res.corners.map((c) => c.name)).toEqual(["First", "Second", "Third"]);
    // Full lap coverage: leading straight, corners, connecting straights, trailing straight
    expect(res.segments[0]).toMatchObject({ type: "straight", startFrac: 0 });
    expect(res.segments[res.segments.length - 1]).toMatchObject({ type: "straight", endFrac: 1 });
  });

  test("a short unnamed gap joins the corners instead of becoming a straight", () => {
    // 7 km lap, corners ~60 m apart: a chute, not a straight.
    const detected = [region(0.1, 0.12, "right"), region(0.1286, 0.15, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Second", direction: "left" },
      ],
    };
    const res = alignSegments(detected, list, 7000);
    expect(res.ok).toBe(true);
    const between = res.segments.slice(
      res.segments.findIndex((s) => s.name === "First") + 1,
      res.segments.findIndex((s) => s.name === "Second"),
    );
    expect(between, "corners should be adjacent, not split by a ~60 m straight").toEqual([]);
  });

  test("a curated straight survives a gap that padding wants to swallow whole", () => {
    // Brands Hatch's Cooper Straight: a ~280 m gap, less than entry+exit padding
    // wants. Padding must reserve enough for the straight to survive rounding.
    const detected = [region(0.3964, 0.4597, "right"), region(0.6062, 0.6457, "right")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "Graham Hill Bend", direction: "right" },
        { number: 2, name: "Surtees", direction: "right" },
      ],
      straights: [{ after: 1, name: "Cooper Straight" }],
    };
    const res = alignSegments(detected, list, 1925);
    expect(res.ok).toBe(true);
    expect(res.segments.map((s) => s.name), "padding ate the curated straight").toContain("Cooper Straight");
  });

  test("a curated straight survives even when short", () => {
    // Brands Hatch's Cooper Straight is real at ~55 m — a name outranks the length cutoff.
    const detected = [region(0.1, 0.12, "right"), region(0.1286, 0.15, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Second", direction: "left" },
      ],
      straights: [{ after: 1, name: "Cooper Straight" }],
    };
    const res = alignSegments(detected, list, 7000);
    expect(res.ok).toBe(true);
    expect(res.segments.map((s) => s.name)).toContain("Cooper Straight");
  });

  test("the start/finish straight is named on both sides of the line", () => {
    // The line sits mid-straight, so the straight anchored after the last corner
    // continues past 0 as the lap's leading segment — same tarmac, same name.
    const detected = [region(0.1, 0.15, "right"), region(0.6, 0.65, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Last", direction: "left" },
      ],
      straights: [{ after: 2, name: "Wheatcroft Straight" }],
    };
    const res = alignSegments(detected, list, 5000);
    expect(res.ok).toBe(true);
    // Both halves grouped: one straight, split by the line, so consumers label it once.
    expect(res.segments[0]).toMatchObject({
      type: "straight",
      name: "Wheatcroft Straight",
      group: "Wheatcroft Straight",
      startFrac: 0,
    });
    expect(res.segments[res.segments.length - 1]).toMatchObject({
      type: "straight",
      name: "Wheatcroft Straight",
      group: "Wheatcroft Straight",
      endFrac: 1,
    });
  });

  test("an unnamed leading straight stays unnamed", () => {
    const detected = [region(0.1, 0.15, "right"), region(0.6, 0.65, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Last", direction: "left" },
      ],
    };
    const res = alignSegments(detected, list, 5000);
    expect(res.segments[0]).toMatchObject({ type: "straight", name: "" });
  });

  test("a curated name claims a bend too shallow to be a corner on its own", () => {
    // Spa's Raidillon integrates to ~0.19 rad, under the kink cutoff, so the
    // detector marks it weak. The name list says it's a corner, so it counts.
    const weak = { ...region(0.16, 0.17, "right"), turnRad: 0.15, weak: true };
    const detected = [region(0.1, 0.15, "left"), weak];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "Eau Rouge", direction: "left", group: "Eau Rouge/Raidillon" },
        { number: 2, name: "Raidillon", direction: "right", group: "Eau Rouge/Raidillon" },
      ],
    };
    const res = alignSegments(detected, list, 7000);
    expect(res.ok).toBe(true);
    const complex = res.corners.filter((c) => c.group === "Eau Rouge/Raidillon");
    expect(
      complex.map((c) => c.number),
      "the weak region should be part of the complex",
    ).toEqual([1, 2]);
    // The complex must reach the weak region's geometry, not stop at the strong one
    expect(complex[complex.length - 1].endFrac).toBeGreaterThan(0.17);
  });

  test("an unnamed weak bend stays part of the straight", () => {
    const weak = { ...region(0.4, 0.41, "right"), turnRad: 0.15, weak: true };
    const detected = [region(0.1, 0.15, "left"), weak, region(0.7, 0.75, "right")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "left" },
        { number: 2, name: "Second", direction: "right" },
      ],
    };
    const res = alignSegments(detected, list, 7000);
    expect(res.ok).toBe(true);
    // Two named corners, and the kink between them is not promoted to a third
    expect(res.corners.map((c) => c.name)).toEqual(["First", "Second"]);
    expect(res.segments.filter((s) => s.type === "corner")).toHaveLength(2);
  });

  test("direction mismatch is a hard failure", () => {
    const detected = [region(0.1, 0.15, "left"), region(0.4, 0.45, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Second", direction: "left" },
      ],
    };
    // Both polarities fail: normal has T1 wrong, mirrored has T2 wrong
    expect(alignSegments(detected, list).ok).toBe(false);
  });

  test("count mismatch without annotations is a hard failure", () => {
    const detected = [region(0.1, 0.15, "right"), region(0.2, 0.25, "left"), region(0.4, 0.45, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [{ number: 1, name: "Only", direction: "right" }],
    };
    expect(alignSegments(detected, list).ok).toBe(false);
  });

  test("grouped chicane keeps per-turn entries tagged with the group name", () => {
    const detected = [region(0.1, 0.16, "right"), region(0.5, 0.55, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "In", direction: "right", group: "Chicane" },
        { number: 2, name: "Out", direction: "left", group: "Chicane" },
        { number: 3, name: "Hairpin", direction: "left" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.cost).toBeLessThan(1);
    expect(res.corners[0].name).toBe("In");
    expect(res.corners[0].group).toBe("Chicane");
    expect(res.corners.filter((c) => c.group === "Chicane").map((c) => c.number)).toEqual([1, 2]);
    expect(res.corners[res.corners.length - 1].name).toBe("Hairpin");
    expect(res.corners[res.corners.length - 1].group).toBeUndefined();
  });

  test("mirrored coordinate system is auto-detected and directions corrected", () => {
    const detected = [region(0.1, 0.15, "left"), region(0.4, 0.45, "right"), region(0.8, 0.85, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "A", direction: "right" },
        { number: 2, name: "B", direction: "left" },
        { number: 3, name: "C", direction: "right" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.corners.map((c) => c.direction)).toEqual(["right", "left", "right"]);
    expect(res.issues.some((i) => i.message.includes("mirrored"))).toBe(true);
  });

  test("straight names anchor after their corner", () => {
    const detected = [region(0.1, 0.15, "right"), region(0.5, 0.55, "left")];
    const list: TrackFacts = {
      ...FACTS,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Second", direction: "left" },
      ],
      straights: [{ after: 1, name: "Back Straight" }],
    };
    const res = alignSegments(detected, list);
    const named = res.segments.find((s) => s.type === "straight" && s.name === "Back Straight");
    expect(named).toMatchObject({ startFrac: 0.15, endFrac: 0.5 });
  });
});

describe("validateFacts", () => {
  const base = FACTS;

  test("complete list passes", () => {
    const issues = validateFacts({
      ...base,
      corners: [
        { number: 1, name: "A" },
        { number: 2, name: "B", covers: [3] },
        { number: 4, name: "C" },
      ],
    });
    expect(issues).toEqual([]);
  });

  test("missing turn number fails", () => {
    const issues = validateFacts({
      ...base,
      corners: [{ number: 1, name: "A" }, { number: 2, name: "B" }, { number: 4, name: "C" }],
    });
    expect(issues.some((i) => i.message.includes("turn 3 unaccounted"))).toBe(true);
  });

  test("duplicate turn number fails", () => {
    const issues = validateFacts({
      ...base,
      corners: [
        { number: 1, name: "A" },
        { number: 2, name: "B", covers: [2, 3] },
        { number: 4, name: "C" },
      ],
    });
    expect(issues.some((i) => i.message.includes("listed twice"))).toBe(true);
  });

  test("out-of-order numbering fails", () => {
    const issues = validateFacts({
      ...base,
      corners: [
        { number: 2, name: "B" },
        { number: 1, name: "A" },
        { number: 3, name: "C", covers: [4] },
      ],
    });
    expect(issues.some((i) => i.message.includes("out of racing order"))).toBe(true);
  });
});

describe("real geometry: Spa (ACC centerline)", () => {
  const spaVenueDir = resolve(
    import.meta.dir,
    "../../../shared/data/tracks/venues/circuit-de-spa-francorchamps",
  );
  const csv = readFileSync(resolve(spaVenueDir, "geometry/acc/spa-centerline.csv"), "utf-8");
  const pts = csv.split("\n").filter(Boolean).slice(1).map((l) => {
    const [x, z] = l.split(",").map(Number);
    return { x, z };
  });
  const metadata: unknown = JSON.parse(
    readFileSync(resolve(spaVenueDir, "revisions/current/tracks/grand-prix/metadata.json"), "utf-8"),
  );
  if (!metadata || typeof metadata !== "object" || !("facts" in metadata)) {
    throw new Error("Spa metadata is missing track facts");
  }
  const facts = TrackFactsSchema.parse(metadata.facts);

  test("detects and names the full corner sequence", () => {
    const { corners, totalDist } = detectCornerRegions(pts);
    expect(totalDist).toBeGreaterThan(6800);
    expect(totalDist).toBeLessThan(7100);

    const res = alignSegments(corners, facts);
    expect(res.ok).toBe(true);
    expect(res.cost).toBeLessThan(1);

    const names = res.corners.map((c) => c.name);
    for (const expected of ["La Source", "Les Combes", "Rivage", "Pouhon", "Stavelot", "Blanchimont", "Bus Stop"]) {
      expect(names).toContain(expected);
    }

    // La Source is the first corner, shortly after the start line, turning right
    expect(res.corners[0]).toMatchObject({ name: "La Source", direction: "right" });
    expect(res.corners[0].startFrac).toBeGreaterThan(0.02);
    expect(res.corners[0].startFrac).toBeLessThan(0.08);

    // Kemmel straight follows Eau Rouge/Raidillon
    const kemmel = res.segments.find((s) => s.name === "Kemmel");
    expect(kemmel).toBeDefined();
    expect(kemmel!.type).toBe("straight");
  });
});
