import { describe, expect, test } from "bun:test";

import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import { telemetryToTrackConditions } from "../../server/ai/track-conditions";

function sample(values: SemanticTelemetrySample["values"]): SemanticTelemetrySample {
  return { sequence: "0", observedAtMs: 0, values };
}

describe("telemetryToTrackConditions", () => {
  test("summarizes fresh canonical weather values and converts wind m/s for display", () => {
    const conditions = telemetryToTrackConditions([
      sample({
        "weather.air-temp": 20,
        "weather.track-temp": 30,
        "weather.rain-percent": 5,
        "weather.wind-speed": 10,
        "weather.wind-direction": 90,
        "weather.track-rubber-state": [{ value: "moderate usage" }],
      }),
      sample({
        "weather.air-temp": 22,
        "weather.track-temp": 34,
        "weather.rain-percent": 15,
        "weather.wind-speed": 20,
        "weather.wind-direction": 110,
      }),
    ]);

    expect(conditions).toMatchObject({
      frames: 2,
      airTempC: { min: 20, max: 22, avg: 21 },
      roadTempC: { min: 30, max: 34, avg: 32 },
      rainIntensity: 0.1,
      wet: true,
      windSpeedKmh: 54,
      windDirectionDeg: 100,
      trackRubberState: "moderate usage",
    });
  });

  test("leaves an unavailable condition summary null instead of synthesizing zero values", () => {
    expect(telemetryToTrackConditions([sample({})])).toBeNull();
  });
});
