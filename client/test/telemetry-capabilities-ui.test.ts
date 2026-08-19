import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import type { LivePitData } from "../../shared/racing/live/types";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { AnalyseF1ErsPanel } from "../src/components/analyse/AnalyseF1ErsPanel";
import { AnalyseDataPanel, buildAnalyseClipboardText } from "../src/components/analyse/AnalyseDataPanel";
import { AnalyseDynamicsPanel } from "../src/components/analyse/AnalyseDynamicsPanel";
import { MetricsPanel } from "../src/components/analyse/AnalyseMetricsPanel";
import { AnalyseSuspensionPanel } from "../src/components/analyse/AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "../src/components/analyse/AnalyseTireWheelsPanel";
import type { SemanticAnalysisFrame } from "../src/components/track-map/types";
import { LiveTelemetry } from "../src/components/LiveTelemetry";
import { FuelGauge, PowerTorque } from "../src/components/telemetry/Gauges";
import { PitEstimate } from "../src/components/telemetry/PitEstimate";
import { SurfaceConditions } from "../src/components/telemetry/SurfaceConditions";
import { TelemetryCharts } from "../src/components/telemetry/TelemetryCharts";
import { TireDiagram } from "../src/components/telemetry/TireDiagram";
import { LiveTrackConditions } from "../src/components/tunes/LiveTestDashboard";
import type { LiveTelemetryView } from "../src/lib/live-telemetry-view";
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
  temp: (value: number) => value,
} as never;
const parityUnits = {
  ...units,
  speed: (value: number) => value * 2.23694,
  speedLabel: "mph",
  temperatureUnit: "C",
} as never;

const f1ParityFrame = semanticFrame({
  "motion.speed": 30,
  "engine.current-engine-rpm": 12000,
  "inputs.gear": 7,
  "inputs.throttle": 0.8,
  "inputs.brake": 0.2,
  "inputs.steering": -32 / 128,
  "engine.boost": 0.4,
  "engine.power": 745700,
  "engine.torque": 620,
  "fuel.remaining-fraction": 0.42,
  "fuel.remaining-percent": 42,
  "motion.acceleration-x": 4.905,
  "motion.acceleration-z": 9.81,
  "brakes.brake-bias": 0.6,
  "motion.angular-velocity-y": 0.2,
  "tires.tire-combined-slip": [0.2, 0.4, 0.6, 0.8],
  "tires.tire-slip-ratio": [0.1, 0.2, 0.3, 0.4],
  "tires.tire-slip-angle": [0.01, 0.02, 0.03, 0.04],
  "tire.temperature.average": [90, 91, 92, 93],
  "brakes.brake-temp": [500, 510, 300, 310],
  "tires.wheel-rotation-speed": [100, 101, 102, 103],
  "tires.tire-wear": [0.1, 0.2, 0.3, 0.4],
  "tires.tire-pressure": [24, 24.5, 23.5, 24],
  "suspension.norm-suspension-travel": [0.2, 0.4, 0.6, 0.8],
  "suspension.suspension-travel-m": [0.02, 0.04, 0.06, 0.08],
  "identity.car-ordinal": 1,
  "fuel.ers-store-energy": 2_000_000,
  "fuel.ers-deployed": 400_000,
  "fuel.ers-harvested": 200_000,
  "fuel.ers-deploy-mode": 4,
  "aero.drs-active": true,
});
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
          "inputs.steering": Math.max(-1, Math.min(1, value.Steer >= 0 ? value.Steer / 127 : value.Steer / 128)),
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
  test("renders complete adapter-gated F1 DRS/ERS panel", () => {
    const markup = renderToStaticMarkup(createElement(AnalyseF1ErsPanel, {
      frame: semanticFrame({ "aero.drs-active": true, "fuel.ers-store-energy": 2_000_000, "fuel.ers-deployed": 400_000, "fuel.ers-harvested": 200_000, "fuel.ers-deploy-mode": "4" }),
    }));
    expect(markup).toContain("DRS / ERS");
    expect(markup).toContain("OPEN");
    expect(markup).toContain("50.0%");
    expect(markup).toContain("10.0%");
    expect(markup).toContain("5.0%");
    expect(markup).toContain("Overtake");
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

  test("renders changing semantic iRacing fuel as a visible fill bar", () => {
    const full = renderToStaticMarkup(
      createElement(FuelGauge, {
        view: {
          simulator: "iracing",
          fuel: { remainingVolumeL: 100, remainingFraction: 1, remainingPercent: 100, capacityL: 100 },
        } as LiveTelemetryView,
      }),
    );
    const used = renderToStaticMarkup(
      createElement(FuelGauge, {
        view: {
          simulator: "iracing",
          fuel: { remainingVolumeL: 60, remainingFraction: 0.6, remainingPercent: 60, capacityL: 100 },
        } as LiveTelemetryView,
      }),
    );

    expect(full).toContain("Fuel 100.0L");
    expect(full).toContain("width:100%");
    expect(used).toContain("Fuel 60.0L");
    expect(used).toContain("width:60%");
    expect(used).toContain("background-color:");
  });

  test("scales pit crew semantic pedal ratios to percentages", () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(LiveTelemetry, {
          mode: "pitcrew",
          view: {
            simulator: "iracing",
            streamId: "test",
            sessionId: 1,
            sequence: 1,
            observedAtMs: 1,
            identity: {},
            motion: {},
            inputs: { throttle: 0.25, brake: 0.125, gear: 3 },
            engine: {},
            fuel: {},
            timing: {},
            tires: {},
            weather: {},
            aero: {},
            ers: {},
            damage: {},
            competitors: [],
            stateBySemanticId: {},
          },
        }),
      ),
    );

    expect(markup).toContain("width:25%");
    expect(markup).toContain("width:12.5%");
    expect(markup).not.toContain("width:6400%");
    expect(markup).not.toContain("width:3200%");
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
  test("renders unavailable semantic fuel without NaN", () => {
    const view: LiveTelemetryView = {
      simulator: "acc",
      streamId: "test",
      sessionId: 1,
      sequence: 1,
      observedAtMs: 1,
      identity: {},
      motion: {},
      inputs: {},
      engine: {},
      fuel: {},
      timing: {},
      tires: {},
      weather: {},
      aero: {},
      ers: {},
      damage: {},
      competitors: [],
      stateBySemanticId: {},
    };
    const markup = renderToStaticMarkup(
      createElement(PitEstimate, { view, pit: null }),
    );
    expect(markup).toContain("Fuel unavailable");
    expect(markup).not.toContain("NaN");
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

  test("keeps unsupported F1 brake row absent and leaves surface diagram unchanged", () => {
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
    expect(brakeMarkup).not.toContain("Brake");
    expect(tireMarkup).toContain("BRK 0°");
    expect(tireMarkup).not.toContain("CURB");
    expect(tireMarkup).not.toContain("WET");
    expect(renderToStaticMarkup(createElement(SurfaceConditions, { packet: value }))).toContain("Surface");
  });

  test("matches main front-channel gates for brake and pressure rows", () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(AnalyseTireWheelsPanel, {
          frame: semanticFrame({
            "tire.temperature.average": [90, 90, 90, 90],
            "tires.tire-wear": [0.1, 0.1, 0.1, 0.1],
            "tires.wheel-rotation-speed": [100, 100, 100, 100],
            "brakes.brake-temp": [0, 0, 300, 310],
            "tires.tire-pressure": [0, 0, 23.5, 24],
          }),
          gameId: "f1-2025",
          units,
          wearRate: null,
        }),
      ),
    );

    expect(markup).not.toContain(">Brake<");
    expect(markup).not.toContain(">Pressure<");
  });

  test("does not fabricate suspension compression from unavailable normalized channels", () => {
    const markup = renderToStaticMarkup(createElement(AnalyseSuspensionPanel, {
      frame: f1ParityFrame,
      gameId: "f1-2025",
    }));
    expect(markup).toContain("20mm");
    expect(markup).toContain(">—</span>");
  });

  test("converts Forza tire values from their recorded Fahrenheit unit", () => {
    const fahrenheitToCelsius = (value: number) => ((value - 32) * 5) / 9;
    const fmUnits = {
      ...parityUnits,
      temp: fahrenheitToCelsius,
      toTempC: fahrenheitToCelsius,
    };
    const frame = semanticFrame({
      "motion.speed": 30,
      "motion.acceleration-x": 0,
      "motion.acceleration-z": 0,
      "motion.angular-velocity-y": 0,
      "tire.temperature.average": [212, 194, 176, 158],
      "tires.wheel-rotation-speed": [1, 1, 1, 1],
      "tires.tire-wear": [0, 0, 0, 0],
      "tires.tire-combined-slip": [0, 0, 0, 0],
      "tires.tire-slip-ratio": [0, 0, 0, 0],
      "tires.normalized-tire-slip-angle": [0, 0, 0, 0],
    });
    const wheelMarkup = renderToStaticMarkup(createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(AnalyseTireWheelsPanel, {
        frame,
        gameId: "fm-2023",
        units: fmUnits,
        wearRate: null,
      }),
    ));
    const dynamicsMarkup = renderToStaticMarkup(createElement(AnalyseDynamicsPanel, {
      frame,
      gameId: "fm-2023",
      units: fmUnits,
    }));
    expect(wheelMarkup).toContain("100°C");
    expect(wheelMarkup).not.toContain("212°C");
    expect(dynamicsMarkup).toContain(">OPT</span>");
    expect(dynamicsMarkup).not.toContain(">OVER</span>");
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
  test("keeps Analyse Data panel main row and section parity", () => {
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(AnalyseDataPanel, {
      sidebarTab: "live",
      onSidebarTabChange: () => {},
      currentFrame: f1ParityFrame,
      startFuel: { remainingFraction: 0.8 },
      gameId: "f1-2025",
      units: parityUnits,
      wearRate: { FL: 0.1, FR: 0.2, RL: 0.3, RR: 0.4 },
      lapInsights: [],
      onJumpToFrame: () => {},
    })));
    expect(markup.indexOf("Brake")).toBeLessThan(markup.indexOf("Steer"));
    expect(markup.indexOf("Slip")).toBeLessThan(markup.indexOf("Wheels"));
    expect(markup.indexOf("Wheels")).toBeLessThan(markup.indexOf("Suspension"));
    expect(markup.indexOf("Suspension")).toBeLessThan(markup.indexOf("DRS / ERS"));
    expect((markup.match(/Grip Ask/g) ?? []).length).toBe(1);
    expect(markup).toContain(">8%</span>");
    expect(markup).not.toContain(">84%</span>");
    expect(markup).toContain(">-0%</span>");
    expect(markup).not.toContain(">10%</span>");
    expect(markup).not.toContain("Lateral slip");
    expect(markup).toContain("Deployed");
    expect(markup).toContain("Harvested");
    expect(markup).toContain("Mode");
    expect(markup).toContain("100.0");
    expect(markup).toContain("90.0%");
    expect(markup).toContain("500°C");
    expect(markup).toContain("24.0 psi");
    expect(markup).toContain("20mm");
    expect(markup.match(/>—</g) ?? []).toHaveLength(2);
  });

  test("renders every supported ACC and AC Evo panel value without placeholders", () => {
    for (const gameId of ["acc", "ac-evo"] as const) {
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: new QueryClient() },
          createElement(AnalyseDataPanel, {
            sidebarTab: "live",
            onSidebarTabChange: () => {},
            currentFrame: f1ParityFrame,
            startFuel: { remainingFraction: 0.8 },
            gameId,
            units: parityUnits,
            wearRate: { FL: 0.1, FR: 0.2, RL: 0.3, RR: 0.4 },
            lapInsights: [],
            onJumpToFrame: () => {},
          }),
        ),
      );

      expect(markup, gameId).toContain("60.0%F");
      expect(markup, gameId).toContain("Rotation /s");
      expect(markup, gameId).toContain("Wear /s");
      expect(markup, gameId).toContain("500°C");
      expect(markup, gameId).toContain("24.0 psi");
      expect(markup.match(/>—</g) ?? [], gameId).toHaveLength(0);
    }
  });

  test("builds byte-for-byte main clipboard output", () => {
    const text = buildAnalyseClipboardText({ frame: f1ParityFrame, gameId: "f1-2025", units: parityUnits });
    expect(text).toBe([
      "Speed: 67 mph",
      "RPM: 12000",
      "Gear: 7",
      "Throttle: 80%",
      "Brake: 20%",
      "Steer: -113°",
      "Power: 1000 hp",
      "Fuel: 42.0%",
      "",
      "--- Dynamics ---",
      "G-Force Lat: -0.50g",
      "G-Force Lon: -1.00g",
      "",
      "--- Tire Temps ---",
      "FL: 90  FR: 91",
      "RL: 92  RR: 93",
      "",
      "--- Tire Health ---",
      "FL: 90.0%  FR: 80.0%",
      "RL: 70.0%  RR: 60.0%",
      "",
      "--- Suspension Travel ---",
      "FL: 20mm  FR: 40mm",
      "RL: 60mm  RR: 80mm",
    ].join("\n"));
  });

  test("keeps clipboard tire temperatures in the recorded main packet unit", () => {
    const text = buildAnalyseClipboardText({
      frame: semanticFrame({
        ...f1ParityFrame.values,
        "tire.temperature.average": [212, 194, 176, 158],
      }),
      gameId: "fm-2023",
      units: { ...parityUnits, temperatureUnit: "F" },
    });
    expect(text).toContain("FL: 212  FR: 194");
    expect(text).not.toContain("414");
  });

  test("renders catalog-backed wheel and vehicle surface rows", () => {
    const fm = renderToStaticMarkup(createElement(AnalyseDynamicsPanel, {
      frame: semanticFrame({ "motion.speed": 30, "inputs.steering": 0, "tires.wheel-rotation-speed": [100, 101, 102, 103], "tires.tire-combined-slip": [0, 0, 0, 0], "tires.tire-slip-ratio": [0, 0, 0, 0], "tires.normalized-tire-slip-angle": [0, 0, 0, 0], "tires.wheel-on-rumble-strip": [true, false, false, false], "tires.wheel-in-puddle-depth": [0, 0.4, 0, 0] }),
      gameId: "fm-2023",
      units: parityUnits,
    }));
    expect(fm.indexOf("CURB")).toBeLessThan(fm.indexOf("Slip"));
    expect(fm).toContain("GRIP");
    const iracing = renderToStaticMarkup(createElement(AnalyseDynamicsPanel, { frame: semanticFrame({ "identity.player-track-surface": 1 }), gameId: "iracing", units: parityUnits }));
    expect(iracing.indexOf("Pit stall")).toBeLessThan(iracing.indexOf("Slip"));
  });
  test("keeps dynamics metrics out of compact cursor summary", () => {
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(MetricsPanel, {
          frame: semanticFrame({
            "motion.speed": 30,
            "inputs.throttle": 128 / 255,
            "inputs.brake": 0,
            "inputs.steering": 0,
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
