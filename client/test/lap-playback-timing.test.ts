import { describe, expect, test } from "bun:test";
import { hasTelemetryGap } from "@raceiq/lap-replay/ui"

describe("Replay telemetry gaps", () => {
  test("does not mark floating-point 10 Hz samples as gaps", () => {
    expect(
      hasTelemetryGap(0.055000000000063665, 0.15499999999997272),
    ).toBe(false);
    expect(hasTelemetryGap(0.055, 0.157)).toBe(true);
  });
});
