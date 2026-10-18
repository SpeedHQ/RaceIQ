import { describe, expect, test } from "bun:test";
import { RECORDING_FREQUENCIES_HZ } from "@raceiq/shared/platform/runtime/recording-frequency";
import { NativeCaptureRateLimiter } from "../../../games/shared/native-capture-rate-limiter";

describe("NativeCaptureRateLimiter", () => {
  for (const frequencyHz of RECORDING_FREQUENCIES_HZ) {
    test(`${frequencyHz}Hz preserves phase over 100Hz opportunities`, () => {
      const limiter = new NativeCaptureRateLimiter();
      let admitted = 0;
      for (let tick = 0; tick < 1000; tick++) {
        if (limiter.shouldCapture(tick * 10, frequencyHz)) admitted++;
      }
      expect(admitted).toBe(frequencyHz * 10);
    });

    test(`${frequencyHz}Hz cannot manufacture 60Hz source updates`, () => {
      const limiter = new NativeCaptureRateLimiter();
      let admitted = 0;
      for (let tick = 0; tick < 600; tick++) {
        if (limiter.shouldCapture(tick * 1000 / 60, frequencyHz)) admitted++;
      }
      expect(admitted).toBe(frequencyHz === 50 ? 500 : 600);
    });
  }

  test("first, changed frequency, reset and regressed clock rephase immediately", () => {
    const limiter = new NativeCaptureRateLimiter();
    expect(limiter.shouldCapture(100, 50)).toBe(true);
    expect(limiter.shouldCapture(101, 50)).toBe(false);
    expect(limiter.shouldCapture(101, 60)).toBe(true);
    expect(limiter.shouldCapture(102, 60)).toBe(false);
    limiter.reset();
    expect(limiter.shouldCapture(102, 60)).toBe(true);
    expect(limiter.shouldCapture(0, 60)).toBe(true);
    expect(limiter.shouldCapture(1, 60)).toBe(false);
  });

  test("stall admits only current frame, then retains original phase", () => {
    const limiter = new NativeCaptureRateLimiter();
    expect(limiter.shouldCapture(0, 50)).toBe(true);
    expect(limiter.shouldCapture(5007, 50)).toBe(true);
    expect(limiter.shouldCapture(5007, 50)).toBe(false);
    expect(limiter.shouldCapture(5019, 50)).toBe(false);
    expect(limiter.shouldCapture(5020, 50)).toBe(true);
    expect(limiter.shouldCapture(5020, 50)).toBe(false);
  });
});
