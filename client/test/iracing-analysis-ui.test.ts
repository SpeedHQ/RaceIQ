import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import type { TelemetryPacket } from "../../shared/types";
import { AnalyseDynamicsPanel } from "../src/components/analyse/AnalyseDynamicsPanel";
import { AnalyseSuspensionPanel } from "../src/components/analyse/AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "../src/components/analyse/AnalyseTireWheelsPanel";
import { buildSegmentData } from "../src/components/analyse/AnalyseSegmentList";
import { pathForwardOffsets } from "../src/components/analyse/AnalyseTrackMap";
import type { useUnits } from "../src/hooks/useUnits";
import { fakeAccPacket } from "../src/stories/fakeData";

initGameAdapters();

const units = {
  tempLabel: "°C",
  thresholds: { cold: 75, warm: 115, hot: 150 },
  toTempC: (value: number) => value,
} as ReturnType<typeof useUnits>;

const packet: TelemetryPacket = {
  ...fakeAccPacket,
  gameId: "iracing",
  acc: undefined,
  iracing: {
    sessionTick: 123,
    sessionNum: 0,
    driverCarIdx: 1,
    trackLengthM: 4000,
    lapDistanceM: 2000,
    lapDistancePct: 0.5,
    onPitRoad: false,
    playerTrackSurface: 1,
    incidents: 0,
    trackWetness: 0,
    carName: "Test Car",
    carClassName: "Test Class",
    trackName: "Test Track",
  },
  AccelerationX: 11.38,
  AccelerationZ: -0.1,
  WheelRotationSpeedFL: 0,
  WheelRotationSpeedFR: 0,
  WheelRotationSpeedRL: 0,
  WheelRotationSpeedRR: 0,
  TireSlipAngleFL: 0,
  TireSlipAngleFR: 0,
  TireSlipAngleRL: 0,
  TireSlipAngleRR: 0,
  TireTempFL: 63,
  TireTempFR: 60,
  TireTempRL: 65,
  TireTempRR: 63,
  TireWearFL: 0.012,
  TireWearFR: 0.012,
  TireWearRL: 0.01,
  TireWearRR: 0.01,
  TirePressureFrontLeft: 23.5,
  TirePressureFrontRight: 23.5,
  TirePressureRearLeft: 24.5,
  TirePressureRearRight: 24.5,
  NormSuspensionTravelFL: 0.39,
  NormSuspensionTravelFR: 0.59,
  NormSuspensionTravelRL: 0.18,
  NormSuspensionTravelRR: 0.46,
  SuspensionTravelMFL: 0.039,
  SuspensionTravelMFR: 0.059,
  SuspensionTravelMRL: 0.018,
  SuspensionTravelMRR: 0.046,
};

describe("iRacing analysis panels", () => {
  test("does not render fabricated grip, traction, balance, or slip values", () => {
    const markup = renderToStaticMarkup(
      createElement(AnalyseDynamicsPanel, {
        currentPacket: packet,
        gameId: "iracing",
        units,
      }),
    );

    expect(markup).toContain("Unavailable");
    expect(markup).toContain("Last pit temp");
    expect(markup).toContain("Pit stall");
    expect(markup).not.toContain("200%");
    expect(markup).not.toContain("LOCK");
    expect(markup).not.toContain("-100%");
  });

  test("labels pit snapshots and cold pressure and removes invalid wear rate", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AnalyseTireWheelsPanel, {
          currentPacket: packet,
          currentDisplayPacket: null,
          gameId: "iracing",
          units,
          wearRate: { FL: 0, FR: 0, RL: 0, RR: 0 },
        }),
      ),
    );

    expect(markup).toContain("Last pit temp");
    expect(markup).toContain("Last pit health");
    expect(markup).toContain("Cold pressure");
    expect(markup).not.toContain("Wear /s");
    expect(markup).not.toContain(">0.0<");
  });

  test("shows raw shock travel and names compression bias honestly", () => {
    const markup = renderToStaticMarkup(createElement(AnalyseSuspensionPanel, { currentPacket: packet }));

    expect(markup).toContain("39mm");
    expect(markup).toContain("59mm");
    expect(markup).toContain("Compression bias");
    expect(markup).toContain("Front 60%");
    expect(markup).toContain("Left 35%");
    expect(markup).not.toContain(">39%<");
  });
});

describe("iRacing analysis track marker", () => {
  test("keeps projected-path direction through repeated positions and corners", () => {
    const directions = pathForwardOffsets([
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
      { x: 1, z: 1 },
      { x: 1, z: 1 },
    ]);

    expect(directions[0]).toEqual([1, 0]);
    expect(directions[1]).toEqual([1, 0]);
    expect(directions[2]?.[0]).toBeCloseTo(Math.SQRT1_2);
    expect(directions[2]?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(directions[3]).toEqual([0, 1]);
    expect(directions[4]).toEqual([0, 1]);
    expect(
      pathForwardOffsets([
        { x: 4, z: 2 },
        { x: 4, z: 2 },
      ]),
    ).toEqual([null, null]);
  });
});

describe("iRacing analysis segment timing", () => {
  test("uses lap distance when world positions are unavailable", () => {
    const telemetry = Array.from({ length: 101 }, (_, index) => ({
      DistanceTraveled: 7000 + index * 20,
      CurrentLap: index * 0.5,
      PositionX: 0,
      PositionZ: 0,
    })) as TelemetryPacket[];
    const segments = [
      { type: "straight", name: "", startFrac: 0, endFrac: 0.25 },
      { type: "corner", name: "T1", startFrac: 0.25, endFrac: 0.5 },
      { type: "straight", name: "", startFrac: 0.5, endFrac: 0.75 },
      { type: "corner", name: "T2", startFrac: 0.75, endFrac: 1 },
    ];

    const result = buildSegmentData(telemetry, segments);

    expect(result?.staticSegments.map((segment) => segment.time)).toEqual([
      12.5,
      12.5,
      12.5,
      12.5,
    ]);
    expect(result?.staticSegments.map((segment) => segment.name)).toEqual([
      "S1",
      "T1",
      "S2",
      "T2",
    ]);
  });
});
