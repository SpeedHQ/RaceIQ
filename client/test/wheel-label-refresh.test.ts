import { expect, test } from "bun:test";
import { createWheelLabelRefreshPolicy } from "../src/lib/wheel-label-refresh";

test("active playback coalesces newest card content, while pause and seek paint immediately", () => {
  const card = createWheelLabelRefreshPolicy<string>();
  card.update("initial", 0, 0);
  expect(card.consume(0, true, 0)).toBe("initial");
  card.update("stale", 20, 0);
  expect(card.consume(20, true, 0)).toBeUndefined();
  card.update("newest", 80, 0);
  expect(card.consume(80, true, 0)).toBeUndefined();
  expect(card.consume(100, true, 0)).toBe("newest");
  card.update("paused", 110, 0);
  expect(card.consume(110, false, 0)).toBe("paused");
  card.update("seek", 111, 1);
  expect(card.consume(111, true, 1)).toBe("seek");
  card.update("recording", 112, 1);
  expect(card.consume(112, false, 1)).toBe("recording");
  expect(card.consume(113, false, 1)).toBeUndefined();
});
