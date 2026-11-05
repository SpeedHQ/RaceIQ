import { describe, expect, test } from "bun:test";
import { dispatchCornerAction, resolveCornerActionRanges, segmentToDistanceRange, startCornerFocus } from "../../ui/corner-focus";
import type { SpectateSegment, TurnIdentity } from "../../contracts";
import type { SpectateController, SpectateSnapshot } from "../../contracts/spectate";

function fakeController() {
  const calls: string[] = [];
  let distance = 0;
  let seeking = false;
  const listeners = new Set<() => void>();
  const snapshot = (): SpectateSnapshot =>
    ({ time: 0, duration: 0, playing: true, speed: 1, positionLock: false, canLock: false, seeking, generation: 0, seekGeneration: 0, a: { time: 0, distance, pose: null, values: {} }, b: null }) as SpectateSnapshot;
  const controller: SpectateController = {
    getSnapshot: snapshot,
    getFrameSnapshot: snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    scrub: () => {},
    seekDistance: (value) => { calls.push(`seek:${value}`); distance = value; seeking = true; setTimeout(() => { seeking = false; listeners.forEach((l) => l()); }, 0); },
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
    driveTo(value: number) { distance = value; listeners.forEach((listener) => listener()); },
  };
}

describe("corner focus", () => {
  test("maps segment fractions to distance with the overview conversion", () => {
    expect(segmentToDistanceRange({ startFrac: 0.25, endFrac: 0.5 }, { maximum: 1000, distanceOrigin: 100 })).toEqual({ start: 150, end: 400 });
    expect(segmentToDistanceRange({ startFrac: 0.5, endFrac: 0.25 }, { maximum: 1000, distanceOrigin: 0 })).toEqual({ start: 250, end: 500 });
    expect(segmentToDistanceRange({ startFrac: 0.2, endFrac: 0.2 }, { maximum: 1000, distanceOrigin: 0 })).toBeNull();
    expect(segmentToDistanceRange({ startFrac: 0, endFrac: 1 }, { maximum: 0, distanceOrigin: 0 })).toBeNull();
  });

  test("seeks to entry, plays, and pauses at exit without looping", async () => {
    const fake = fakeController();
    let exited = 0;
    const handle = startCornerFocus(fake.controller, { ranges: [{ start: 200, end: 400 }], loop: false, onExit: () => { exited++; } });
    expect(handle?.entry).toBe(200);
    expect(handle?.exit).toBe(400);
    expect(fake.calls).toEqual(["seek:200", "play"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.driveTo(399);
    expect(fake.calls).toEqual(["seek:200", "play"]);
    fake.driveTo(401);
    expect(fake.calls).toContain("pause");
    expect(exited).toBe(1);
  });

  test("loops back to entry instead of pausing", async () => {
    const fake = fakeController();
    startCornerFocus(fake.controller, { ranges: [{ start: 100, end: 200 }], loop: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.driveTo(205);
    expect(fake.calls.filter((call) => call.startsWith("seek:"))).toEqual(["seek:100", "seek:100"]);
    expect(fake.calls).not.toContain("pause");
  });

  test("uses the latest exit across linked ranges", () => {
    const fake = fakeController();
    const handle = startCornerFocus(fake.controller, { ranges: [{ start: 100, end: 200 }, { start: 120, end: 260 }], loop: false });
    expect(handle?.entry).toBe(100);
    expect(handle?.exit).toBe(260);
  });

  test("returns null when no usable range exists", () => {
    const fake = fakeController();
    expect(startCornerFocus(fake.controller, { ranges: [], loop: false })).toBeNull();
    expect(startCornerFocus(fake.controller, { ranges: [{ start: 5, end: 5 }], loop: false })).toBeNull();
  });
});

describe("corner action ranges", () => {
  const turns: TurnIdentity[] = [
    { key: "turn:1", number: 1, name: "TGR Corner", aliases: ["turn one"] },
    { key: "turn:10", number: 10, name: "Hairpin" },
  ];
  const segments: SpectateSegment[] = [
    { name: "TGR Corner", type: "corner", startFrac: 0.1, endFrac: 0.2 },
    { name: "Hairpin", type: "corner", startFrac: 0.6, endFrac: 0.7 },
  ];
  const scale = { maximum: 1000, distanceOrigin: 0 };

  test("matches roster names and aliases, not substrings", () => {
    const ranges = resolveCornerActionRanges({ action: { cornerKey: "turn:10" }, turns, segments, scale, loop: false });
    expect(ranges).toEqual([{ start: 600, end: 700 }]);
  });

  test("matches segment.number when present", () => {
    const numbered: SpectateSegment[] = [{ number: 1, name: "Anything", type: "corner", startFrac: 0.1, endFrac: 0.2 }];
    expect(resolveCornerActionRanges({ action: { cornerKey: "turn:1" }, turns, segments: numbered, scale, loop: false })).toEqual([{ start: 100, end: 200 }]);
  });

  test("unknown corner or missing geometry refuses instead of seeking", () => {
    expect(resolveCornerActionRanges({ action: { cornerKey: "turn:99" }, turns, segments, scale, loop: false })).toBeNull();
    expect(resolveCornerActionRanges({ action: { cornerKey: "turn:1" }, turns, segments: [{ name: "Other", type: "corner", startFrac: 0, endFrac: 0.1 }], scale, loop: false })).toBeNull();
  });

  test("dispatch drives the controller only when geometry resolves", () => {
    const fake = fakeController();
    expect(dispatchCornerAction(fake.controller, { action: { cornerKey: "turn:99" }, turns, segments, scale, loop: false })).toBeNull();
    const handle = dispatchCornerAction(fake.controller, { action: { cornerKey: "turn:1" }, turns, segments, scale, loop: false });
    expect(handle?.entry).toBe(100);
    expect(fake.calls).toEqual(["seek:100", "play"]);
  });
});

