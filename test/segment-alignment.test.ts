import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  alignSegments,
  detectCornerRegions,
  resolveSectors,
  validateNameList,
  type CornerRegion,
  type CornerNameList,
} from "../shared/track-segment-align";

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
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
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

  test("direction mismatch is a hard failure", () => {
    const detected = [region(0.1, 0.15, "left"), region(0.4, 0.45, "left")];
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
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
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
      corners: [{ number: 1, name: "Only", direction: "right" }],
    };
    expect(alignSegments(detected, list).ok).toBe(false);
  });

  test("grouped chicane collapses into one region and takes the group name", () => {
    const detected = [region(0.1, 0.16, "right"), region(0.5, 0.55, "left")];
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
      corners: [
        { number: 1, name: "In", direction: "right", group: "Chicane" },
        { number: 2, name: "Out", direction: "left", group: "Chicane" },
        { number: 3, name: "Hairpin", direction: "left" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.cost).toBeLessThan(1);
    expect(res.corners[0].name).toBe("Chicane");
    expect(res.corners[0].numbers).toEqual([1, 2]);
    expect(res.corners[1].name).toBe("Hairpin");
  });

  test("spans merges a double-apex corner split into two regions into one segment", () => {
    const detected = [region(0.1, 0.14, "left"), region(0.15, 0.19, "left"), region(0.6, 0.65, "right")];
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
      corners: [
        { number: 1, name: "Double", direction: "left", spans: 2 },
        { number: 2, name: "Simple", direction: "right" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.cost).toBeLessThan(1);
    const doubles = res.corners.filter((c) => c.name === "Double");
    expect(doubles).toHaveLength(1);
    expect(doubles[0]).toMatchObject({ startFrac: 0.1, endFrac: 0.19 });
  });

  test("optional corner may be absent", () => {
    const detected = [region(0.1, 0.15, "right"), region(0.6, 0.65, "left")];
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
      corners: [
        { number: 1, name: "First", direction: "right" },
        { number: 2, name: "Shallow", direction: "right", optional: true },
        { number: 3, name: "Last", direction: "left" },
      ],
    };
    const res = alignSegments(detected, list);
    expect(res.ok).toBe(true);
    expect(res.corners.map((c) => c.name)).toEqual(["First", "Last"]);
    expect(res.issues.some((i) => i.message.includes("Shallow"))).toBe(true);
  });

  test("mirrored coordinate system is auto-detected and directions corrected", () => {
    const detected = [region(0.1, 0.15, "left"), region(0.4, 0.45, "right"), region(0.8, 0.85, "left")];
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
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
    const list: CornerNameList = {
      circuit: "Test",
      turnCount: 99,
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

describe("validateNameList", () => {
  const base = { circuit: "Test", turnCount: 4 };

  test("complete list passes", () => {
    const issues = validateNameList({
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
    const issues = validateNameList({
      ...base,
      corners: [{ number: 1, name: "A" }, { number: 2, name: "B" }, { number: 4, name: "C" }],
    });
    expect(issues.some((i) => i.message.includes("turn 3 unaccounted"))).toBe(true);
  });

  test("duplicate turn number fails", () => {
    const issues = validateNameList({
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
    const issues = validateNameList({
      ...base,
      corners: [
        { number: 2, name: "B" },
        { number: 1, name: "A" },
        { number: 3, name: "C", covers: [4] },
      ],
    });
    expect(issues.some((i) => i.message.includes("out of racing order"))).toBe(true);
  });

  test("number beyond turnCount fails", () => {
    const issues = validateNameList({
      ...base,
      corners: [
        { number: 1, name: "A", covers: [2, 3] },
        { number: 4, name: "B" },
        { number: 5, name: "C" },
      ],
    });
    expect(issues.some((i) => i.message.includes("outside 1..4"))).toBe(true);
  });
});

describe("resolveSectors", () => {
  const corners = [
    { regionIndex: 0, numbers: [1], name: "A", direction: "right" as const, startFrac: 0.1, endFrac: 0.3 },
    { regionIndex: 1, numbers: [2], name: "B", direction: "left" as const, startFrac: 0.6, endFrac: 0.7 },
  ];

  test("anchors resolve to corner exit plus offset", () => {
    const { sectors } = resolveSectors(
      { s1EndAfterCorner: 1, s1OffsetM: 500, s2EndAfterCorner: 2 },
      corners,
      5000,
    );
    expect(sectors).toEqual({ s1End: 0.4, s2End: 0.7, source: "corner-anchored" });
  });

  test("missing anchor falls back to explicit fraction", () => {
    const { sectors, issues } = resolveSectors(
      { s1EndAfterCorner: 99, s1End: 0.33, s2EndAfterCorner: 2 },
      corners,
      5000,
    );
    expect(sectors).toMatchObject({ s1End: 0.33, s2End: 0.7, source: "hand-researched" });
    expect(issues.some((i) => i.severity === "warning")).toBe(true);
  });

  test("invalid ordering yields no sectors", () => {
    const { sectors } = resolveSectors({ s1End: 0.8, s2End: 0.4 }, corners, 5000);
    expect(sectors).toBeNull();
  });
});

describe("real geometry: Spa (ACC centerline)", () => {
  const csv = readFileSync(resolve(import.meta.dir, "../shared/tracks/acc/spa-centerline.csv"), "utf-8");
  const pts = csv.split("\n").filter(Boolean).slice(1).map((l) => {
    const [x, z] = l.split(",").map(Number);
    return { x, z };
  });
  const nameList: CornerNameList = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../shared/tracks/corner-names/spa.json"), "utf-8"),
  );

  test("detects and names the full corner sequence", () => {
    const { corners, totalDist } = detectCornerRegions(pts);
    expect(totalDist).toBeGreaterThan(6800);
    expect(totalDist).toBeLessThan(7100);

    const res = alignSegments(corners, nameList);
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

    // Sector anchors land near the known Spa boundaries
    const { sectors } = resolveSectors(nameList.sectors!, res.corners, totalDist);
    expect(sectors!.s1End).toBeGreaterThan(0.29);
    expect(sectors!.s1End).toBeLessThan(0.36);
    expect(sectors!.s2End).toBeGreaterThan(0.69);
    expect(sectors!.s2End).toBeLessThan(0.78);
  });
});
