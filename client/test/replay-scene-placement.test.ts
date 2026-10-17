import { describe, expect, test } from "bun:test";
import { alignProjectionToMeasured, resolveScenePoses, type TrackProjection } from "../src/components/wireframe/ScenePlacement";
import { alignOfficialReferenceToPositions, resolveTrackPositions } from "../src/components/analyse/track-map/path";
import type { SemanticAnalysisFrame } from "../src/components/analyse/track-map/types";
import { buildTrackIndex, filterByDistanceIndexed } from "../src/lib/wireframe-utils";

const projection: TrackProjection = {
  points: [[100, 100, 0, 1], [100, 200, 1, 0], [200, 200, 0, -1], [200, 100, -1, 0]]
    .flatMap(([x, z, dx, dz]) => Array.from({ length: 20 }, (_, index) => ({ x: x + dx * index * 5, z: z + dz * index * 5 })))
    .concat({ x: 100, z: 100 }),
  source: "official-svg", units: "m", start: "start-finish", direction: "forward",
};
const frame = (values: Record<string, unknown>, states: Record<string, string> = {}, freshness: Record<string, string> = {}): SemanticAnalysisFrame => ({ values, states, freshness });

describe("replay scene placement", () => {
  test("projects iRacing lap distance separately from unsupported native coordinates", () => {
    const sample = frame({ "timing.lap-fraction": 0.125, "motion.yaw": -2 });
    const pose = resolveScenePoses("iracing", [sample], projection)[0]!;
    expect(pose).toEqual({ x: 100, z: 150, yaw: 0, source: "lap-fraction" });
    expect(sample.values["motion.position-x"]).toBeUndefined();
    expect(sample.values["motion.yaw"]).toBe(-2);
    const geometry = filterByDistanceIndexed(buildTrackIndex(projection.points), pose.x, pose.z, pose.yaw, -0.44);
    expect(geometry.some(({ points }) => points.some(([x, , z]) => Math.abs(x) < 1 && Math.abs(z) < 1))).toBe(true);
    expect(geometry.flatMap(({ points }) => points.flat()).every(Number.isFinite)).toBe(true);
  });

  test("start/finish is continuous across lap wrap without reversed heading", () => {
    const poses = resolveScenePoses("iracing", [0.999, 1, 0, 0.001].map((fraction) => frame({ "timing.lap-fraction": fraction })), projection);
    expect(poses[1]!.x).toBe(poses[2]!.x);
    expect(poses[1]!.z).toBe(poses[2]!.z);
    expect(Math.hypot(poses[0]!.x - poses[3]!.x, poses[0]!.z - poses[3]!.z)).toBeLessThan(1);
    expect(poses[3]!.yaw).toBe(0);
  });

  test("missing, invalid, stale distance and incomplete native position remain unavailable", () => {
    const samples = [frame({}), ...[-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY].map((fraction) => frame({ "timing.lap-fraction": fraction })),
      frame({ "timing.lap-fraction": 0.5 }, { "timing.lap-fraction": "unavailable" }),
      frame({ "timing.lap-fraction": 0.5 }, {}, { "timing.lap-fraction": "stale" }),
      frame({ "motion.position-x": 20, "motion.yaw": 0 })];
    expect(resolveScenePoses("iracing", samples, projection)).toEqual(samples.map(() => null));
    expect(resolveScenePoses("iracing", [frame({ "timing.lap-fraction": 0.5 })], null)).toEqual([null]);
    expect(resolveScenePoses("iracing", [frame({ "timing.lap-fraction": 0.5 })], { ...projection, points: [{ x: NaN, z: 1 }, { x: 2, z: 3 }] })).toEqual([null]);
  });

  test("native AC EVO positions and heading win without changing coordinate conventions", () => {
    const sample = frame({ "motion.position-x": -140, "motion.position-z": 50, "motion.yaw": 0.4, "timing.lap-fraction": 0.5 });
    expect(resolveScenePoses("ac-evo", [sample], projection)[0]).toEqual({ x: -140, z: 50, yaw: 0.4, source: "native" });
    expect(resolveScenePoses("iracing", [sample], projection)[0]!.source).toBe("native");
    expect(resolveScenePoses("ac-evo", [frame({ "timing.lap-fraction": 0.5 })], projection)).toEqual([null]);
  });
  test("uses fresh geographic samples, compass heading, and measured altitude", () => {
    const poses = resolveScenePoses("iracing", [
      frame({ "motion.latitude": 0, "motion.longitude": 0, "motion.yaw-north": 0 }),
      frame({ "motion.latitude": 53, "motion.longitude": -2, "motion.altitude": 100, "motion.yaw-north": Math.PI / 2 }),
      frame({ "motion.latitude": 53.0001, "motion.longitude": -2, "motion.altitude": 104, "motion.yaw-north": 0 }, {}, { "motion.latitude": "stale" }),
      frame({ "motion.latitude": 53.0001, "motion.longitude": -2, "motion.altitude": 104, "motion.yaw-north": 0 }),
    ], projection);
    expect(poses[0]).toBeNull();
    expect(poses[1]).toMatchObject({ x: 0, z: 0, y: 0, yaw: Math.PI / 2, source: "measured" });
    expect(poses[2]).toBeNull();
    expect(poses[3]).toMatchObject({ x: 0, z: expect.closeTo(11.1, 0), y: 4, yaw: 0, source: "measured" });
  });
  test("2D geographic path uses track origin and preserves missing-sample gaps", () => {
    const positions = resolveTrackPositions([
      frame({ "identity.track.latitude": 53, "identity.track.longitude": -2, "motion.latitude": 53, "motion.longitude": -2 }),
      frame({ "identity.track.latitude": 53, "identity.track.longitude": -2 }),
      frame({ "identity.track.latitude": 53, "identity.track.longitude": -2, "motion.latitude": 53.0001, "motion.longitude": -2 }),
    ], projection.points, "iracing");
    expect(positions[0].x).toBe(0);
    expect(positions[0].z).toBe(0);
    expect(Number.isNaN(positions[1].x)).toBe(true);
    expect(positions[2].z).toBeCloseTo(11.1, 0);
    const elevationPath = buildTrackIndex([{ x: 0, z: 0, y: 0 }, { x: 0, z: 10, y: 4 }]);
    const ribbon = filterByDistanceIndexed(elevationPath, 0, 10, 0, -0.42, 60, undefined, undefined, 4);
    expect(ribbon[0].points[0][1]).toBeCloseTo(-4.42);
    expect(ribbon[0].points[1][1]).toBeCloseTo(-0.42);
  });
  test("aligns only official reference geometry into measured frame", () => {
    const measured = projection.points.map((point) => ({ ...point, x: point.x + 500, z: point.z - 200, yaw: 0, source: "measured" as const }));
    const aligned = alignProjectionToMeasured(projection, measured)!;
    expect(aligned.points[0].x).toBeCloseTo(projection.points[0].x + 500);
    expect(aligned.points[0].z).toBeCloseTo(projection.points[0].z - 200);
    expect(measured[0].x).toBe(projection.points[0].x + 500);
  });
  test("track geographic metadata alone does not replace live-only lap-fraction placement", () => {
    const sample = frame({
      "identity.track.latitude": 53.180009,
      "identity.track.longitude": -2.612779,
      "identity.track.altitude": 69.47,
      "timing.lap-fraction": 0.125,
    });
    expect(resolveTrackPositions([sample], projection.points, "iracing")).toEqual([{ x: 100, z: 150 }]);
    expect(resolveScenePoses("iracing", [sample], projection)[0]).toMatchObject({
      x: 100, z: 150, source: "lap-fraction",
    });
  });
  test("keeps pit lanes and map labels in the same measured frame as the official outline", () => {
    const positions = projection.points.map((point) => ({ x: point.x + 500, z: point.z - 200 }));
    const reference = {
      outline: projection.points,
      boundaries: null,
      mapLabels: [{ x: 105, z: 105, text: "Pit entry" }],
      pitLines: [{ kind: "pit-road" as const, points: [{ x: 105, z: 105 }, { x: 105, z: 130 }] }],
    };
    const aligned = alignOfficialReferenceToPositions(reference, positions);
    expect(aligned.mapLabels![0].x).toBeCloseTo(605);
    expect(aligned.mapLabels![0].z).toBeCloseTo(-95);
    expect(aligned.pitLines![0].points[1].x).toBeCloseTo(605);
    expect(aligned.pitLines![0].points[1].z).toBeCloseTo(-70);
    expect(reference.pitLines[0].points[0]).toEqual({ x: 105, z: 105 });
    const unavailable = alignOfficialReferenceToPositions(reference, [{ x: NaN, z: NaN }]);
    expect(unavailable.outline).toBeNull();
    expect(unavailable.pitLines).toBeNull();
  });
});
