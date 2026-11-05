import { describe, expect, test } from "bun:test";
import {
  cornerTurnsFromSegments,
  distanceScaleForLap,
  resolveSessionCornerFocus,
  startCornerFocus,
} from "../../ui/corner-focus";
import type { SpectateLap, SpectateSegment } from "../../contracts";
import type { SpectateController, SpectateSnapshot } from "../../contracts/spectate";

function fakeController(aDistance = 0, bDistance = 0) {
  const calls: string[] = [];
  let a = aDistance;
  let b = bDistance;
  let seeking = false;
  const listeners = new Set<() => void>();
  const snapshot = (): SpectateSnapshot =>
    ({
      time: 0, duration: 0, playing: true, speed: 1, positionLock: false, canLock: false,
      seeking, generation: 0, seekGeneration: 0,
      a: { time: 0, distance: a, pose: null, values: {} },
      b: { time: 0, distance: b, pose: null, values: {} },
    }) as SpectateSnapshot;
  const controller: SpectateController = {
    getSnapshot: snapshot,
    getFrameSnapshot: snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    scrub: () => {},
    seekDistance: (value) => { calls.push(`seek:${value}`); a = value; seeking = true; setTimeout(() => { seeking = false; listeners.forEach((l) => l()); }, 0); },
    seekFrame: () => {},
    setSpeed: () => {},
    setPositionLock: () => {},
    setActive: () => {},
    dispose: () => {},
    sample: () => ({ a: null, b: null }),
  };
  return {
    controller,
    calls,
    drive(nextA: number, nextB: number) { a = nextA; b = nextB; listeners.forEach((listener) => listener()); },
  };
}

const segments: SpectateSegment[] = [
  { name: "TGR Corner", type: "corner", startFrac: 0.1, endFrac: 0.2, number: 1 },
  { name: "Hairpin", type: "corner", startFrac: 0.6, endFrac: 0.7, number: 10 },
  { name: "Pouhon", type: "corner", startFrac: 0.8, endFrac: 0.9, number: 12, covers: [13] },
];

function scales() {
  return {
    a: { maximum: 1000, distanceOrigin: 0 },
    b: { maximum: 1000, distanceOrigin: 0 },
  };
}

describe("corner turns from loaded segments", () => {
  test("keeps exact turn identity for T1 versus T10", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(turns.some((turn) => turn.key === "t1" && turn.number === 1)).toBe(true);
    expect(turns.some((turn) => turn.key === "t10" && turn.number === 10)).toBe(true);
  });

  test("exposes covered turn numbers and the canonical multi-turn key", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(turns.some((turn) => turn.key === "t13" && turn.number === 13)).toBe(true);
    expect(turns.some((turn) => turn.key === "t12-13" && turn.number === 12)).toBe(true);
  });
});

describe("session corner focus resolution", () => {
  test("solo and A resolve against the A lap and pause on A", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t1", target: "solo" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 100, end: 200 }], rangesBySide: { a: [{ start: 100, end: 200 }], b: [] }, primary: "a", primaryExit: 200,
    });
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "A" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 600, end: 700 }], rangesBySide: { a: [{ start: 600, end: 700 }], b: [] }, primary: "a", primaryExit: 700,
    });
  });

  test("a covered turn number or its canonical multi-turn key resolves to the containing corner", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t13", target: "solo" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 800, end: 900 }], rangesBySide: { a: [{ start: 800, end: 900 }], b: [] }, primary: "a", primaryExit: 900,
    });
    expect(resolveSessionCornerFocus({ cornerKey: "t12-13", target: "solo" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 800, end: 900 }], rangesBySide: { a: [{ start: 800, end: 900 }], b: [] }, primary: "a", primaryExit: 900,
    });
  });

  test("resolves the prompt label used in prose", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "Hairpin (10)", target: "solo" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 600, end: 700 }], rangesBySide: { a: [{ start: 600, end: 700 }], b: [] }, primary: "a", primaryExit: 700,
    });
  });

  test("B resolves against the B lap and pauses on B", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "B" }, turns, segments, scales())).toEqual({
      ranges: [{ start: 600, end: 700 }], rangesBySide: { a: [], b: [{ start: 600, end: 700 }] }, primary: "b", primaryExit: 700,
    });
  });

  test("linked resolves both laps and requires both exits", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "linked" }, turns, segments, scales())).toEqual({
      ranges: [
        { start: 600, end: 700 },
        { start: 600, end: 700 },
      ],
      rangesBySide: { a: [{ start: 600, end: 700 }], b: [{ start: 600, end: 700 }] },
      primary: "a",
      primaryExit: 700,
      exits: [{ side: "b", distance: 700 }],
    });
  });

  test("refuses B or linked without a B lap and unknown corners", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "B" }, turns, segments, { a: scales().a, b: null })).toBeNull();
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "linked" }, turns, segments, { a: scales().a, b: null })).toBeNull();
    expect(resolveSessionCornerFocus({ cornerKey: "t99", target: "solo" }, turns, segments, scales())).toBeNull();
  });

  test("refuses a range outside the loaded lap coverage", () => {
    const turns = cornerTurnsFromSegments(segments);
    expect(resolveSessionCornerFocus({ cornerKey: "t1", target: "solo" }, turns, segments, {
      ...scales(),
      coverage: { a: { distance: 150, hasProgress: true }, b: null },
    })).toBeNull();
    expect(resolveSessionCornerFocus({ cornerKey: "t1", target: "solo" }, turns, segments, {
      ...scales(),
      coverage: { a: { distance: 1000, hasProgress: false }, b: null },
    })).toBeNull();
    expect(resolveSessionCornerFocus({ cornerKey: "t10", target: "linked" }, turns, segments, {
      ...scales(),
      coverage: { a: { distance: 1000, hasProgress: true }, b: { distance: 650, hasProgress: true } },
    })).toBeNull();
  });
});

describe("linked corner focus playback", () => {
  test("keeps playing until A and B each pass their own exit", async () => {
    const fake = fakeController(100, 120);
    const handle = startCornerFocus(fake.controller, {
      ranges: [{ start: 100, end: 200 }, { start: 120, end: 260 }],
      loop: false,
      primary: "a",
      primaryExit: 200,
      exits: [{ side: "b", distance: 260 }],
    });
    expect(handle?.entry).toBe(100);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.drive(250, 250);
    expect(fake.calls).not.toContain("pause");
    fake.drive(199, 270);
    expect(fake.calls).not.toContain("pause");
    fake.drive(200, 260);
    expect(fake.calls).toContain("pause");
  });

  test("B exit controls a B-only focus", async () => {
    const fake = fakeController(100, 120);
    startCornerFocus(fake.controller, {
      ranges: [{ start: 600, end: 700 }],
      loop: false,
      primary: "b",
      primaryExit: 700,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.drive(700, 699);
    expect(fake.calls).not.toContain("pause");
    fake.drive(700, 700);
    expect(fake.calls).toContain("pause");
  });
});

describe("distance scale for a replay lap", () => {
  test("uses authoritative track length and converts the recording origin", () => {
    const lap = {
      trackLengthM: 1000,
      distance: 500,
      samples: [{ distance: 50, values: { "timing.distance-traveled": 150 } }],
    } as unknown as SpectateLap;
    expect(distanceScaleForLap(lap, 900)).toEqual({ maximum: 1000, distanceOrigin: 100 });
  });

  test("falls back to the comparison distance and zero origin", () => {
    const lap = { distance: 500, samples: [] } as unknown as SpectateLap;
    expect(distanceScaleForLap(lap, 900)).toEqual({ maximum: 900, distanceOrigin: 0 });
    expect(distanceScaleForLap(lap)).toEqual({ maximum: 500, distanceOrigin: 0 });
  });
});
