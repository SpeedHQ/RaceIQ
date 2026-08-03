import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LivePitData, TelemetryPacket } from "../../shared/types";
import { initGameAdapters } from "../../shared/games/init";
import { AnalyseTireWheelsPanel } from "../src/components/analyse/AnalyseTireWheelsPanel";
import { TelemetryCharts } from "../src/components/telemetry/TelemetryCharts";
import { SurfaceConditions } from "../src/components/telemetry/SurfaceConditions";
import { TireDiagram } from "../src/components/telemetry/TireDiagram";
import { LiveTrackConditions } from "../src/components/tunes/LiveTestDashboard";
import { FuelGauge, PowerTorque } from "../src/components/telemetry/Gauges";
import { PitEstimate } from "../src/components/telemetry/PitEstimate";
import { fakeAccPacket, fakeF1Packet, fakeForzaPacket, fakePit } from "../src/stories/fakeData";

initGameAdapters();
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
        currentPacket: value,
        currentDisplayPacket: null,
        gameId: value.gameId,
        units,
        wearRate: null,
      }),
    ),
  );
}

function renderTireDiagram(value: TelemetryPacket): string {
  const queryClient = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(TireDiagram, { packet: value }),
    ),
  );
}

describe("telemetry capability UI", () => {
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
    expect(accMarkup).toBe("");
  });

  test("shows litre fuel without inventing a percentage when capacity is unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(FuelGauge, {
        packet: {
          ...fakeAccPacket,
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
  test("omits ACC weather and per-wheel surface placeholders", () => {
    const value = packet("acc", {
      WeatherType: 0,
      TrackTemp: 0,
      AirTemp: 0,
      WheelOnRumbleStripFL: 1,
      WheelInPuddleDepthFR: 0.4,
    });

    const tireMarkup = renderTireDiagram(value);
    expect(
      renderToStaticMarkup(createElement(LiveTrackConditions, { packet: value })),
    ).toBe("");
    expect(
      renderToStaticMarkup(createElement(SurfaceConditions, { packet: value })),
    ).toBe("");
    expect(tireMarkup).not.toContain("CURB");
    expect(tireMarkup).not.toContain("WET");
  });

  test("keeps supported clear and zero-degree conditions visible", () => {
    const markup = renderToStaticMarkup(
      createElement(LiveTrackConditions, {
        packet: packet("ac-evo", {
          WeatherType: 0,
          TrackTemp: 0,
          AirTemp: 0,
        }),
      }),
    );

    expect(markup).toContain("Clear");
    expect(markup).toContain("Track 0°C");
    expect(markup).toContain("Air 0°C");
  });

  test("keeps supported FM surface zero distinct from unsupported pit and brake fields", () => {
    const value = packet("fm-2023", {
      BrakeTempFrontLeft: 500,
      BrakeTempFrontRight: 500,
      BrakeTempRearLeft: 400,
      BrakeTempRearRight: 400,
      acc: { pitStatus: "in_pit" } as never,
    });
    const surfaceMarkup = renderToStaticMarkup(
      createElement(SurfaceConditions, { packet: value }),
    );
    const pitMarkup = renderToStaticMarkup(
      createElement(PitEstimate, { packet: value, pit: null }),
    );

    expect(surfaceMarkup).toContain("Surface");
    expect(surfaceMarkup).toContain("—");
    expect(renderTireAnalysis(value)).not.toContain("Brake");
    expect(pitMarkup).not.toContain("IN PIT");
  });

  test("renders supported F1 brake zero but omits unsupported surface fields", () => {
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
    expect(
      renderToStaticMarkup(createElement(SurfaceConditions, { packet: value })),
    ).toBe("");
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
    const chartsMarkup = renderToStaticMarkup(
      createElement(TelemetryCharts, { packet: value as never }),
    );
    const pitMarkup = renderToStaticMarkup(
      createElement(PitEstimate, { packet: value, pit }),
    );
    const tireMarkup = renderTireDiagram(value);
    const weatherMarkup = renderToStaticMarkup(
      createElement(LiveTrackConditions, {
        packet: { ...value, TrackTemp: 32, AirTemp: 23, RainPercent: 0 },
      }),
    );

    expect(renderToStaticMarkup(createElement(PowerTorque, { packet: value }))).toBe("");
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
});
