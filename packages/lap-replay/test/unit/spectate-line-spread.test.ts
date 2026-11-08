import { expect, test } from "bun:test";
import type { ReplayLineSpread } from "../../contracts/host"
import { windowLineSpread } from "../../ui/spectate-line-spread"

const trace: ReplayLineSpread = { fracs: [0, 0.25, 0.5, 0.75, 1], spreadM: [0, 0, 4, 0, 0], lapCount: 2, overallSpreadM: 0.8, consistencyScore: 84 };

test("local window excludes distant divergence and integrates partial bins", () => {
  expect(windowLineSpread(trace, 0, 0.25)).toBe(0);
  expect(windowLineSpread(trace, 0.375, 0.625)).toBe(3);
  expect(windowLineSpread(trace, 0.75, 1)).toBe(0);
});

test("start and stationary windows use interpolated current spread", () => {
  expect(windowLineSpread(trace, 0, 0)).toBe(0);
  expect(windowLineSpread(trace, 0.375, 0.375)).toBe(2);
  expect(windowLineSpread(trace, 1, 1)).toBe(0);
});

test("missing progress, reversed windows, and unavailable traces stay unavailable", () => {
  expect(windowLineSpread(null, 0, 1)).toBeNull();
  expect(windowLineSpread(trace, NaN, 1)).toBeNull();
  expect(windowLineSpread(trace, 0.5, 0.25)).toBeNull();
  expect(windowLineSpread(trace, -0.1, 0.2)).toBeNull();
  expect(windowLineSpread(trace, 0.9, 1.1)).toBeNull();
  expect(windowLineSpread({ ...trace, lapCount: 1 }, 0, 1)).toBeNull();
  expect(windowLineSpread({ ...trace, spreadM: [] }, 0, 1)).toBeNull();
  expect(windowLineSpread({ ...trace, spreadM: [0, 0, NaN, 0, 0] }, 0.3, 0.6)).toBeNull();
});
