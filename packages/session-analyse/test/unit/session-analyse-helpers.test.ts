import { describe, expect, test } from "bun:test";
import type { SemanticTuneSample } from "@raceiq/analysis-core/racing/laps/semantic-tune";
import { buildOpenLapContext } from "../../ui/open-lap-context";
import { tireSnapshot } from "../../ui/tire-snapshot";

const sample: SemanticTuneSample = {
  gameId: "acc",
  fuelUnit: "litre",
  positionM: { x: 1, z: 2 },
  tireWearFraction: { fl: 0, fr: 0.1, rl: 0.2, rr: 0.3 },
};

describe("session analyse helpers", () => {
  test("builds open-lap context using metric-native units and temperature conversion", () => {
    const context = buildOpenLapContext({
      focusLap: {
        id: 1, sessionId: 1, lapNumber: 2, lapTime: 90, isValid: true,
        classification: null, createdAt: "2026-01-01T00:00:00Z", carId: "car", trackId: "track",
      },
      sectorTimes: null,
      laps: [],
      corners: null,
      ranges: { sectors: [{ FL: { n: 1, min: 24, max: 26, avg: 25 } }] },
      metric: { label: "Pressure", unit: "psi" },
      cornerKeys: ["FL"],
      temperatureUnit: "F",
    });
    expect(context).toContain("FL 24-26 (avg 25)");
    expect(context).not.toContain("°F");

    const temperatureContext = buildOpenLapContext({
      focusLap: {
        id: 1, sessionId: 1, lapNumber: 2, lapTime: 90, isValid: true,
        classification: null, createdAt: "2026-01-01T00:00:00Z", carId: "car", trackId: "track",
      },
      sectorTimes: null,
      laps: [],
      corners: null,
      ranges: { sectors: [{ FL: { n: 1, min: 24, max: 26, avg: 25 } }] },
      metric: { label: "Core temp", unit: "°C", quantity: "temperature" },
      cornerKeys: ["FL"],
      temperatureUnit: "F",
    });
    expect(temperatureContext).toContain("FL 75°F-79°F (avg 77°F)");
  });

  test("preserves absent tire channels and legitimate zero wear", () => {
    const snapshot = tireSnapshot([sample]);
    expect(snapshot?.FL.wear).toBe(0);
    expect(snapshot?.FL.tempC).toBeUndefined();
    expect(snapshot?.FR.wear).toBe(0.1);
    expect(tireSnapshot([])).toBeNull();
  });
});
