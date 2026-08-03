import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ANALYSIS_TELEMETRY,
  resolveAnalysisTelemetry,
} from "../shared/racing/analysis/telemetry-capabilities";
import { initGameAdapters } from "../shared/games/init";
import { getGame } from "../shared/games/registry";
import { suspensionCompression } from "../shared/racing/analysis/laps/physics/vehicle";
import type { TelemetryPacket } from "../shared/telemetry/types";

initGameAdapters();

describe("analysis telemetry capabilities", () => {
  test("iRacing declares source limitations and snapshot freshness explicitly", () => {
    const analysis = resolveAnalysisTelemetry(getGame("iracing"));

    expect(analysis.gForce).toEqual({
      source: "derived",
      confidence: "exact",
    });
    expect(analysis.slipRatio).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(analysis.wheelRotation).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(analysis.tireTemperature).toEqual({
      source: "direct",
      freshness: "pit-snapshot",
      display: "per-wheel",
    });
    expect(analysis.tirePressure).toEqual({
      source: "direct",
      freshness: "static",
      display: "cold-pressure",
    });
    expect(analysis.suspensionTravel).toEqual({
      source: "direct",
      freshness: "continuous",
      display: "millimeters",
    });
  });

  test("other adapters override only their real source differences", () => {
    expect(resolveAnalysisTelemetry(getGame("f1-2025")).surface).toEqual({
      source: "unavailable",
      reason: "source-limitation",
    });
    expect(resolveAnalysisTelemetry(getGame("ac-evo")).suspensionTravel).toEqual({
      source: "direct",
      freshness: "continuous",
      display: "millimeters",
    });
    expect(resolveAnalysisTelemetry(getGame("fm-2023")).slipRatio).toEqual(
      DEFAULT_ANALYSIS_TELEMETRY.slipRatio,
    );
  });
});

describe("suspension compression distribution", () => {
  test("normalizes all four corners instead of presenting averages as load", () => {
    const packet = {
      NormSuspensionTravelFL: 0.39,
      NormSuspensionTravelFR: 0.59,
      NormSuspensionTravelRL: 0.18,
      NormSuspensionTravelRR: 0.46,
    } as TelemetryPacket;

    const compression = suspensionCompression(packet);

    expect(compression.frontBias).toBeCloseTo(0.98 / 1.62);
    expect(compression.leftBias).toBeCloseTo(0.57 / 1.62);
  });
});
