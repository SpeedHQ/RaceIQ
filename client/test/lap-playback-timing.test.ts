import { describe, expect, test } from "bun:test";
import { REACT_STATE_INTERVAL_MS } from "../src/hooks/useLapPlayback";

describe("Analyse playback cadence", () => {
  test("publishes React playback state at 60Hz", () => {
    expect(REACT_STATE_INTERVAL_MS).toBeCloseTo(1000 / 60, 5);
  });
});
