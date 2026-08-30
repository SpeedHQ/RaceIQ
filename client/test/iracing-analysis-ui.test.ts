import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "../../shared/games/init";
import { AnalyseDynamicsPanel } from "../src/components/analyse/AnalyseDynamicsPanel";
import { AnalyseSuspensionPanel } from "../src/components/analyse/AnalyseSuspensionPanel";
import { AnalyseTireWheelsPanel } from "../src/components/analyse/AnalyseTireWheelsPanel";
import { buildSegmentData } from "../src/components/analyse/AnalyseSegmentList";
import { pathForwardOffsets } from "../src/components/analyse/track-map/path";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import type { useUnits } from "../src/hooks/useUnits";

initGameAdapters({ iracingAdapter: true });

const units = { temp: (value: number) => value, tempLabel: "°C", thresholds: { cold: 75, warm: 115, hot: 150 }, toTempC: (value: number) => value } as ReturnType<typeof useUnits>;
const frame = (values: Record<string, unknown>): SemanticAnalysisFrame => ({ values, states: {}, freshness: {} });
const iracingFrame = frame({
  "motion.speed": 30,
  "motion.acceleration-x": 11.38,
  "motion.acceleration-z": -0.1,
  "motion.angular-velocity-y": 0.1,
  "identity.player-track-surface": 1,
  "tires.tire-pressure": [23.5, 23.5, 24.5, 24.5],
  "tires.tire-wear": [0.012, 0.012, 0.01, 0.01],
  "tire.temperature.average": [63, 60, 65, 63],
  "suspension.suspension-travel-m": [0.039, 0.059, 0.018, 0.046],
});

describe("iRacing analysis panels", () => {
  test("keeps main rows visible without fabricated unsupported values", () => {
    const markup = renderToStaticMarkup(createElement(AnalyseDynamicsPanel, { frame: iracingFrame, gameId: "iracing", units }));
    expect(markup).toContain("Understeer");
    expect(markup).toContain("Balance");
    expect(markup).toContain("Grip Ask");
    expect(markup).toContain("Traction");
    expect(markup).toContain("Ratio");
    expect(markup).toContain("Angle");
    expect(markup).toContain("Pit stall");
    expect(markup).not.toContain("200%");
    expect(markup).not.toContain("LOCK");
  });

  test("labels pit snapshots and cold pressure and removes invalid wear rate", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client: queryClient }, createElement(AnalyseTireWheelsPanel, { frame: iracingFrame, gameId: "iracing", units, wearRate: { FL: 0, FR: 0, RL: 0, RR: 0 } })));
    expect(markup).toContain("Last pit temp");
    expect(markup).toContain("Last pit health");
    expect(markup).toContain("Cold pressure");
    expect(markup).not.toContain("Wear /s");
  });

  test("keeps compression bias unavailable when normalized source is a placeholder", () => {
    const markup = renderToStaticMarkup(createElement(AnalyseSuspensionPanel, { frame: iracingFrame, gameId: "iracing" }));
    expect(markup).toContain("39mm");
    expect(markup).toContain("59mm");
    expect(markup).toContain("Compression bias");
    expect(markup.match(/>—</g) ?? []).toHaveLength(2);
  });
});

describe("iRacing analysis track marker", () => {
  test("keeps projected-path direction through repeated positions and corners", () => {
    const directions = pathForwardOffsets([{ x: 0, z: 0 }, { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 1, z: 1 }]);
    expect(directions[0]).toEqual([1, 0]);
    expect(directions[1]).toEqual([1, 0]);
    expect(directions[2]?.[0]).toBeCloseTo(Math.SQRT1_2);
    expect(directions[2]?.[1]).toBeCloseTo(Math.SQRT1_2);
    expect(directions[3]).toEqual([0, 1]);
    expect(directions[4]).toEqual([0, 1]);
    expect(pathForwardOffsets([{ x: 4, z: 2 }, { x: 4, z: 2 }])).toEqual([null, null]);
  });
});

describe("iRacing analysis segment timing", () => {
  test("uses lap distance when world positions are unavailable", () => {
    const telemetry = Array.from({ length: 101 }, (_, index) => frame({ "timing.distance-traveled": 7000 + index * 20, "timing.current-lap": index * 0.5, "motion.position-x": 0, "motion.position-z": 0 }));
    const segments = [{ type: "straight", name: "", startFrac: 0, endFrac: 0.25 }, { type: "corner", name: "T1", startFrac: 0.25, endFrac: 0.5 }, { type: "straight", name: "", startFrac: 0.5, endFrac: 0.75 }, { type: "corner", name: "T2", startFrac: 0.75, endFrac: 1 }];
    const result = buildSegmentData(telemetry, segments);
    expect(result?.staticSegments.map((segment) => segment.time)).toEqual([12.5, 12.5, 12.5, 12.5]);
    expect(result?.staticSegments.map((segment) => segment.name)).toEqual(["S1", "T1", "S2", "T2"]);
  });

  test("combines start/finish ranges split by the lap boundary", () => {
    const telemetry = Array.from({ length: 101 }, (_, index) =>
      frame({
        "timing.distance-traveled": 7000 + index * 20,
        "timing.current-lap": index * 0.5,
        "motion.position-x": 0,
        "motion.position-z": 0,
      }),
    );
    const segments = [
      {
        type: "straight",
        name: "Frontstretch",
        group: "Frontstretch",
        startFrac: 0,
        endFrac: 0.1,
      },
      {
        type: "corner",
        name: "T1-4",
        startFrac: 0.1,
        endFrac: 0.9,
      },
      {
        type: "straight",
        name: "Frontstretch",
        group: "Frontstretch",
        startFrac: 0.9,
        endFrac: 1,
      },
    ];

    const result = buildSegmentData(telemetry, segments);

    expect(result?.staticSegments).toHaveLength(2);
    expect(result?.staticSegments[0]).toMatchObject({
      name: "Frontstretch",
      time: 10,
      ranges: [
        { startFrac: 0.9, endFrac: 1 },
        { startFrac: 0, endFrac: 0.1 },
      ],
    });
  });
});
