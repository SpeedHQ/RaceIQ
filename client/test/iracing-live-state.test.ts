import { describe, expect, test } from "bun:test";
import { IRACING_LIVE_FRAME_MAX_AGE_MS, selectFreshIRacingLiveView } from "../src/components/iracing/live-state";
import type { LiveTelemetryView } from "../src/lib/live-telemetry-view";

const iracingView = { simulator: "iracing" } as LiveTelemetryView;
const accView = { simulator: "acc" } as LiveTelemetryView;

describe("iRacing live frame readiness", () => {
  test("shows fresh iRacing telemetry without requiring server status", () => {
    expect(selectFreshIRacingLiveView(true, iracingView, 10_000, 10_000)).toBe(iracingView);
  });

  test("hides the view when disconnected, from another simulator, or without a frame", () => {
    expect(selectFreshIRacingLiveView(false, iracingView, 10_000, 10_000)).toBeNull();
    expect(selectFreshIRacingLiveView(true, accView, 10_000, 10_000)).toBeNull();
    expect(selectFreshIRacingLiveView(true, iracingView, null, 10_000)).toBeNull();
  });

  test("expires stopped telemetry after the freshness window", () => {
    expect(selectFreshIRacingLiveView(true, iracingView, 10_000 + 500, 10_000)).toBe(iracingView);
    expect(selectFreshIRacingLiveView(true, iracingView, 10_000, 10_000 + IRACING_LIVE_FRAME_MAX_AGE_MS)).toBe(iracingView);
    expect(selectFreshIRacingLiveView(true, iracingView, 10_000, 10_001 + IRACING_LIVE_FRAME_MAX_AGE_MS)).toBeNull();
  });
});
