import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { AnalyseDynamicsPanel } from "../src/components/analyse/AnalyseDynamicsPanel";
import { IRacingReplayDataPanel } from "../src/components/iracing/IRacingReplayDataPanel";
import { buildSegmentData } from "../src/components/analyse/AnalyseSegmentList";
import { pathForwardOffsets, projectPointOntoPath, resolveFrameDirection } from "../src/components/analyse/track-map/path";
import { sectorIndexForTelemetryIndex } from "../src/components/tunes/SectorRangeBreakdown";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import type { useUnits } from "../src/hooks/useUnits";

initGameAdapters({ iracingAdapter: true, f1Experiments: true });

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
  "tire.temperature.surface.representative": [63, 60, 65, 63],
  "suspension.suspension-travel-m": [0.039, 0.059, 0.018, 0.046],
});

describe("iRacing recorded replay data", () => {
  const replayUnits = { speed: (value: number) => value * 3.6, speedLabel: "km/h", temp: (value: number) => value, tempLabel: "°C" };
  test("shows real recorded channels without unsupported dynamics or compression readouts", () => {
    const markup = renderToStaticMarkup(createElement(IRacingReplayDataPanel, { frame: iracingFrame, units: replayUnits }));
    expect(markup).toContain("108");
    expect(markup).toContain("1.16 g");
    expect(markup).not.toContain("Grip Ask");
    expect(markup).not.toContain("Compression bias");
    expect(markup).not.toContain("Rotation /s");
    expect(markup).not.toContain("Slip");
  });
  test("keeps valid zeros and excludes stale, missing, error and nonfinite current channels", () => {
    const recorded = frame({ "inputs.clutch": 0, "engine.coolant-temperature": 91, "engine.oil-temperature": 999, "engine.voltage": 998, "fuel.fuel-press": Infinity, "engine.oil-pressure": 997, "race.player-incident-count": 0 });
    recorded.states = { "engine.oil-temperature": "stale", "engine.voltage": "missing", "engine.oil-pressure": "error" };
    const markup = renderToStaticMarkup(createElement(IRacingReplayDataPanel, { frame: recorded, units: replayUnits }));
    expect(markup).toContain("0%");
    expect(markup).toContain("91.0°C");
    expect(markup).not.toContain("999");
    expect(markup).not.toContain("998");
    expect(markup).not.toContain("997");
    expect(markup).not.toContain("Infinity");
  });
  test("separates stale pit snapshots from cursor telemetry and does not fabricate partial wheel sets", () => {
    const recorded = frame({ "tire.temperature.carcass.middle": [50, 51, 52, 53], "tires.tire-pressure": [28, 28, 28, 28], "suspension.shock-vel": [0.1, null, 0.2, 0.3] });
    recorded.states = { "tire.temperature.carcass.middle": "stale", "tires.tire-pressure": "stale" };
    const markup = renderToStaticMarkup(createElement(IRacingReplayDataPanel, { frame: recorded, units: replayUnits }));
    expect(markup).toMatch(/<details[^>]*>/);
    expect(markup).not.toMatch(/<details[^>]* open/);
    expect(markup).toContain("not live tire measurements");
    expect(markup).toContain("28.0");
    expect(markup).not.toContain("Shock velocity");
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

test("projects official turn labels onto centerline instead of leaving them on SVG label offsets", () => {
  const projected = projectPointOntoPath({ x: 5, z: 3 }, [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
  ]);
  expect(projected).toEqual({ x: 5, z: 0 });
});

describe("iRacing analysis semantic direction", () => {
  const pathDirection: [number, number] = [1, 0];

  test("prefers fresh valid semantic yaw over path tangent", () => {
    const result = resolveFrameDirection({ values: { "motion.yaw": Math.PI / 2 }, states: { "motion.yaw": "ok" }, freshness: { "motion.yaw": "fresh" } }, pathDirection);
    expect(result?.[0]).toBeCloseTo(1);
    expect(result?.[1]).toBeCloseTo(0);
  });

  test("uses replay path direction when iRacing compass yaw is present without geographic position", () => {
    const result = resolveFrameDirection({
      values: { "motion.yaw": 0, "motion.yaw-north": Math.PI / 2 },
      states: { "motion.yaw": "ok", "motion.yaw-north": "ok" },
      freshness: { "motion.yaw": "fresh", "motion.yaw-north": "fresh" },
    }, pathDirection);
    expect(result).toEqual(pathDirection);
  });

  test("falls back to path tangent for missing, invalid, or stale yaw", () => {
    for (const frame of [
      { values: {}, states: {}, freshness: {} },
      { values: { "motion.yaw": 0 }, states: { "motion.yaw": "error" }, freshness: {} },
      { values: { "motion.yaw": 0 }, states: { "motion.yaw": "ok" }, freshness: { "motion.yaw": "stale" } },
    ]) {
      expect(resolveFrameDirection(frame, pathDirection)).toEqual(pathDirection);
    }
  });
});

test("uses smooth reconstructed MoTeC yaw instead of the projected path tangent", () => {
  const result = resolveFrameDirection({ values: { "motion.yaw": Math.PI / 2 }, states: { "motion.yaw": "ok" }, freshness: { "motion.yaw": "fresh" }, source: "motec" }, [0, 1]);
  expect(result?.[0]).toBeCloseTo(1);
  expect(result?.[1]).toBeCloseTo(0);
});

describe("iRacing analysis segment timing", () => {
  test("uses semantic availability instead of capture provenance", () => {
    const render = (source?: "motec") =>
      renderToStaticMarkup(
        createElement(AnalyseDynamicsPanel, {
          frame: {
            values: { "motion.speed": 40, "brakes.brake-bias": 0 },
            states: {
              "brakes.brake-bias": "missing",
              "tires.tire-slip-angle": "missing",
            },
            freshness: {},
            source,
          },
          gameId: "ac-evo",
          units,
        }),
      );

    const motec = render("motec");
    expect(motec).toBe(render());
    expect(motec).toMatch(/Brake Bias[\s\S]*>—</);
  });

  test("uses lap distance when world positions are unavailable", () => {
    const telemetry = Array.from({ length: 101 }, (_, index) =>
      frame({ "timing.distance-traveled": 7000 + index * 20, "timing.current-lap": index * 0.5, "motion.position-x": 0, "motion.position-z": 0 }),
    );
    const segments = [
      { type: "straight", name: "", startFrac: 0, endFrac: 0.25 },
      { type: "corner", name: "T1", startFrac: 0.25, endFrac: 0.5 },
      { type: "straight", name: "", startFrac: 0.5, endFrac: 0.75 },
      { type: "corner", name: "T2", startFrac: 0.75, endFrac: 1 },
    ];
    const result = buildSegmentData(telemetry, segments);
    expect(result?.staticSegments.map((segment) => segment.time)).toEqual([12.5, 12.5, 12.5, 12.5]);
    expect(result?.staticSegments.map((segment) => segment.name)).toEqual(["S1", "T1", "S2", "T2"]);
  });

});

describe("session Analyse map hover sectors", () => {
  test("routes hovered samples to same sectors used by range bars", () => {
    expect(sectorIndexForTelemetryIndex(0, [4, 8], 3)).toBe(0);
    expect(sectorIndexForTelemetryIndex(3, [4, 8], 3)).toBe(0);
    expect(sectorIndexForTelemetryIndex(4, [4, 8], 3)).toBe(1);
    expect(sectorIndexForTelemetryIndex(8, [4, 8], 3)).toBe(2);
    expect(sectorIndexForTelemetryIndex(99, [4, 8], 3)).toBe(2);
  });
});
