import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import type { LivePitData } from "../../shared/racing/live/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { AnalyseF1ErsPanel } from "../src/components/analyse/AnalyseF1ErsPanel";
import { MetricsPanel } from "../src/components/analyse/AnalyseMetricsPanel";
import { AnalyseTireWheelsPanel } from "../src/components/analyse/AnalyseTireWheelsPanel";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import { FuelGauge, PowerTorque } from "../src/components/telemetry/Gauges";
import { PitEstimate } from "../src/components/telemetry/PitEstimate";
import { SurfaceConditions } from "../src/components/telemetry/SurfaceConditions";
import { TelemetryCharts } from "../src/components/telemetry/TelemetryCharts";
import { TireDiagram } from "../src/components/telemetry/TireDiagram";
import { LiveTrackConditions } from "../src/components/tunes/LiveTestDashboard";
import { fakeAccPacket, fakeF1Packet, fakeForzaPacket, fakePit } from "../src/stories/fakeData";

const semanticFrame = (values: Record<string, unknown>): SemanticAnalysisFrame => ({ values, states: {}, freshness: {} });

initGameAdapters({ f1Experiments: true, iracingAdapter: true });
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    configurable: true,
  });
}
const units = {
  tempLabel: "°C",
  thresholds: { cold: 75, warm: 115, hot: 150 },
  toTempC: (value: number) => value,
} as never;

function packet(gameId: TelemetryPacket["gameId"], overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    gameId,
    Fuel: 0,
    FuelCapacity: undefined,
    CarOrdinal: 1,
    TireTempFL: 0,
    TireTempFR: 0,
    TireTempRL: 0,
    TireTempRR: 0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    WheelRotationSpeedFL: 0,
    WheelRotationSpeedFR: 0,
    WheelRotationSpeedRL: 0,
    WheelRotationSpeedRR: 0,
    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    NormSuspensionTravelFL: 0,
    NormSuspensionTravelFR: 0,
    NormSuspensionTravelRL: 0,
    NormSuspensionTravelRR: 0,
    SuspensionTravelMFL: 0.04,
    SuspensionTravelMFR: 0.04,
    SuspensionTravelMRL: 0.04,
    SuspensionTravelMRR: 0.04,
    Speed: 30,
    Steer: 0,
    Power: 0,
    Torque: 0,
    Boost: 0,
    ...overrides,
  } as TelemetryPacket;
}

function renderTireAnalysis(value: TelemetryPacket): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(AnalyseTireWheelsPanel, {
        frame: semanticFrame({
          "tire.temperature.average": [value.TireTempFL, value.TireTempFR, value.TireTempRL, value.TireTempRR],
          "tires.tire-wear": [value.TireWearFL, value.TireWearFR, value.TireWearRL, value.TireWearRR],
          "tires.tire-slip-angle": [value.TireSlipAngleFL, value.TireSlipAngleFR, value.TireSlipAngleRL, value.TireSlipAngleRR],
          "tires.tire-slip-ratio": [value.TireSlipRatioFL, value.TireSlipRatioFR, value.TireSlipRatioRL, value.TireSlipRatioRR],
          "suspension.norm-suspension-travel": [value.NormSuspensionTravelFL, value.NormSuspensionTravelFR, value.NormSuspensionTravelRL, value.NormSuspensionTravelRR],
          "brakes.brake-temp": [value.BrakeTempFrontLeft, value.BrakeTempFrontRight, value.BrakeTempRearLeft, value.BrakeTempRearRight],
          "inputs.steer": value.Steer,
        }),
        gameId: value.gameId,
        units,
        wearRate: null,
      }),
    ),
  );
}

function renderTireDiagram(value: TelemetryPacket): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(TireDiagram, { packet: value })));
}

describe("telemetry capability UI", () => {
  test("renders both sections when lap exposes DRS and ERS", () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyseF1ErsPanel, {
        frame: semanticFrame({ "aero.drs-active": true, "fuel.ers-store-energy": 2_000_000 }),
        capabilities: { hasDrs: true, hasErs: true },
      }),
    );
    expect(markup).toContain("DRS");
    expect(markup).toContain("ERS");
  });

  test("renders only DRS when ERS is absent from lap", () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyseF1ErsPanel, {
        frame: semanticFrame({ "aero.drs-active": true }),
        capabilities: { hasDrs: true, hasErs: false },
      }),
    );
    expect(markup).toContain("DRS");
    expect(markup).not.toContain("ERS");
  });

  test("renders only ERS when DRS is absent from lap", () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyseF1ErsPanel, {
        frame: semanticFrame({ "fuel.ers-store-energy": 2_000_000 }),
        capabilities: { hasDrs: false, hasErs: true },
      }),
    );
    expect(markup).not.toContain("DRS");
    expect(markup).toContain("ERS");
  });

  test("renders neither section when lap exposes neither capability", () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyseF1ErsPanel, {
        frame: semanticFrame({ "motion.speed": 40 }),
        capabilities: { hasDrs: false, hasErs: false },
      }),
    );
    expect(markup).toBe("");
  });

  test("renders supported power and torque even when their values are zero", () => {
    const forzaMarkup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeForzaPacket, Power: 0, Torque: 0 },
      }),
    );
    const f1Markup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeF1Packet, Power: 0, Torque: 0 },
      }),
    );
    const accMarkup = renderToStaticMarkup(
      createElement(PowerTorque, {
        packet: { ...fakeAccPacket, Power: 0, Torque: 0 },
      }),
    );

    expect(forzaMarkup).toContain("Power");
    expect(forzaMarkup).toContain("Torque");
    expect(f1Markup).toContain("Power");
    expect(f1Markup).not.toContain("Torque");
    expect(accMarkup).toContain("flex justify-center gap-2");
  });

  test("shows litre fuel without inventing a percentage when capacity is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(FuelGauge, {
        packet: {
          gameId: "iracing",
          Fuel: 40,
          FuelCapacity: undefined,
        },
      }),
    );

    expect(markup).toContain("Fuel 40.0L");
    expect(markup).toContain("Fuel capacity unavailable");
    expect(markup).not.toContain("width:40%");
  });

  test("uses a source-provided litre capacity for the fuel fill bar", () => {
    const markup = renderToStaticMarkup(
      createElement(FuelGauge, {
        packet: {
          ...fakeAccPacket,
          Fuel: 40,
          FuelCapacity: 100,
        },
      }),
    );

    expect(markup).toContain("Fuel 40.0L");
    expect(markup).toContain("width:40%");
  });

  test("renders the ACC live dashboard fuel fill from fixture capacity", () => {
    const markup = renderToStaticMarkup(
      createElement(PitEstimate, {
        packet: fakeAccPacket,
        pit: fakePit,
      }),
    );

    expect(fakeAccPacket.FuelCapacity).toBe(120);
    expect(markup).not.toContain("Fuel capacity unavailable");
    expect(markup).toContain(`width:${(fakeAccPacket.Fuel / fakeAccPacket.FuelCapacity) * 100}%`);
  });

  test("keeps F1 dashboard fixture fuel normalized to a tank fraction", () => {
    const markup = renderToStaticMarkup(
      createElement(PitEstimate, {
        packet: fakeF1Packet,
        pit: fakePit,
      }),
    );

    expect(fakeF1Packet.Fuel).toBeGreaterThan(0);
    expect(fakeF1Packet.Fuel).toBeLessThanOrEqual(1);
    expect(markup).toContain("39%");
    expect(markup).not.toContain("4250%");
  });
  test("omits ACC weather and renders explicit surface availability", () => {
    const value = packet("acc", {
      WeatherType: 0,
      TrackTemp: 0,
      AirTemp: 0,
      WheelOnRumbleStripFL: 1,
      WheelInPuddleDepthFR: 0.4,
    });

    const tireMarkup = renderTireDiagram(value);
    expect(renderToStaticMarkup(createElement(LiveTrackConditions, { view: null }))).toBe("");
    const surfaceMarkup = renderToStaticMarkup(createElement(SurfaceConditions, { packet: value }));
    expect(surfaceMarkup).toContain("Surface");
    expect(surfaceMarkup).toContain("CURB");
    expect(surfaceMarkup).toContain("WET");
    expect(tireMarkup).not.toContain("CURB");
    expect(tireMarkup).not.toContain("WET");
  });

  test("omits packet weather because live conditions require semantic view", () => {
    const markup = renderToStaticMarkup(createElement(LiveTrackConditions, { view: null }));
    expect(markup).toBe("");
  });

  test("keeps supported FM surface zero distinct from unsupported pit and brake fields", () => {
    const value = packet("fm-2023", {
      BrakeTempFrontLeft: 500,
      BrakeTempFrontRight: 500,
      BrakeTempRearLeft: 400,
      BrakeTempRearRight: 400,
      acc: { pitStatus: "in_pit" } as never,
    });
    const surfaceMarkup = renderToStaticMarkup(createElement(SurfaceConditions, { packet: value }));
    const pitMarkup = renderToStaticMarkup(createElement(PitEstimate, { packet: value, pit: null }));

    expect(surfaceMarkup).toContain("Surface");
    expect(renderTireAnalysis(value)).toContain("Brake");
    expect(pitMarkup).not.toContain("IN PIT");
  });

  test("renders supported F1 brake zero but keeps explicit surface cells", () => {
    const value = packet("f1-2025", {
      BrakeTempFrontLeft: 0,
      BrakeTempFrontRight: 0,
      BrakeTempRearLeft: 0,
      BrakeTempRearRight: 0,
      WheelOnRumbleStripFL: 1,
      WheelInPuddleDepthFR: 0.4,
    });
    const tireMarkup = renderTireDiagram(value);
    const brakeMarkup = renderTireAnalysis(value);
    expect(brakeMarkup).toContain("Brake");
    expect(brakeMarkup).toContain("0°C");
    expect(tireMarkup).toContain("BRK 0°");
    expect(tireMarkup).not.toContain("CURB");
    expect(tireMarkup).not.toContain("WET");
    expect(renderToStaticMarkup(createElement(SurfaceConditions, { packet: value }))).toContain("Surface");
  });

  test("omits iRacing engine placeholders and live-only tire charts", () => {
    const value = packet("iracing", {
      iracing: {
        onPitRoad: true,
      } as never,
    });
    const pit: LivePitData = {
      fuelPerLap: 2,
      fuelLapsRemaining: 10,
      currentLapFuelUsed: 1,
      tireLapsToBad: 5,
      tireLapsToCritical: 8,
      tireEstimates: {
        toCliff: [5, 5, 5, 5],
        toDead: [8, 8, 8, 8],
        wearPerLap: [0.099, 0.099, 0.099, 0.099],
      },
      tireWearPerLap: 0.099,
      pitInLaps: 5,
      limitedBy: "tires",
      trackLength: 4000,
      estimateSource: "session",
      cliffPct: 60,
      deadPct: 20,
      tireLapsRemaining: 5,
    };
    const chartsMarkup = renderToStaticMarkup(createElement(TelemetryCharts, { packet: value as never }));
    const pitMarkup = renderToStaticMarkup(createElement(PitEstimate, { packet: value, pit }));
    const tireMarkup = renderTireDiagram(value);
    const weatherMarkup = renderToStaticMarkup(
      createElement(LiveTrackConditions, { view: null }),
    );

    expect(renderToStaticMarkup(createElement(PowerTorque, { packet: value }))).toContain("flex justify-center gap-2");
    expect(weatherMarkup).toBe("");
    expect(chartsMarkup).toContain("Speed");
    expect(tireMarkup).not.toContain("Last pit temp 0");
    expect(tireMarkup).not.toContain("Last pit health 100%");
    expect(chartsMarkup).toContain("Throttle / Brake");
    expect(chartsMarkup).not.toContain("Combined Slip");
    expect(chartsMarkup).not.toContain("Tire Temp");
    expect(chartsMarkup).not.toContain("Tire Wear");
    expect(chartsMarkup).not.toContain("Slip Angle");
    expect(chartsMarkup).not.toContain("Slip Ratio");
    expect(chartsMarkup).not.toContain("Suspension");
    expect(tireMarkup).toContain("Last pit temp");
    expect(tireMarkup).toContain("Last pit health");
    expect(tireMarkup).toContain("40mm");
    expect(tireMarkup).not.toContain("0.0°");
    expect(tireMarkup).not.toContain("-100%");
    expect(tireMarkup).not.toContain("LOCK");
    expect(pitMarkup).toContain("Last pit health");
    expect(pitMarkup).toContain("PIT LANE");
    expect(pitMarkup).not.toContain("9.9%");
  });
  test("keeps dynamics metrics out of compact cursor summary", () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MetricsPanel, {
          frame: semanticFrame({
            "motion.speed": 30,
            "inputs.accel": 128,
            "inputs.brake": 0,
            "inputs.steer": 0,
            "inputs.gear": 3,
            "engine.current-engine-rpm": 4_000,
            "tires.normalized-tire-slip-angle": [0.1, 0.1, 0.1, 0.1],
            "tires.tire-combined-slip": [0.2, 0.2, 0.2, 0.2],
            "suspension.suspension-travel-m": [0.04, 0.04, 0.04, 0.04],
          }),
          gameId: "fm-2023",
        }),
      ),
    );
    expect(markup).toContain("Speed");
    expect(markup).not.toContain("Lateral slip");
    expect(markup).not.toContain("Grip Ask");
    expect(markup).not.toContain("Suspension");
  });
});
