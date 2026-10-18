import { expect, test } from "bun:test";
import type { IRacingTrackMapTelemetry } from "../src/hooks/laps";
import { buildIRacingMeasuredMapPaths, projectIRacingDistanceToOutline } from "../src/components/comparison/iracing-map-path";

function replay(latitudeOffset: number): IRacingTrackMapTelemetry {
  return {
    lapId: latitudeOffset === 0 ? 1 : 2,
    trackOrigin: { latitude: 53, longitude: -2 },
    samples: [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
      latitude: 53 + latitudeOffset + fraction * 0.001,
      longitude: -2 + fraction * 0.001,
      fraction,
    })),
  };
}

test("iRacing IBT map paths preserve measured offsets between laps", () => {
  const [lapA, lapB] = buildIRacingMeasuredMapPaths([replay(0), replay(0.00001)], [0, 25, 50, 75, 100]);
  expect(lapA).not.toBeNull();
  expect(lapB).not.toBeNull();
  expect(lapA).toHaveLength(5);
  expect(lapB).toHaveLength(5);
  expect(Math.abs(lapA![2]!.z - lapB![2]!.z)).toBeGreaterThan(0.5);
});

test("track origin metadata alone does not create a measured iRacing path", () => {
  const replay: IRacingTrackMapTelemetry = {
    lapId: 1,
    trackOrigin: { latitude: 53, longitude: -2 },
    samples: [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({ latitude: null, longitude: null, fraction })),
  };
  expect(buildIRacingMeasuredMapPaths([replay], [0, 25, 50, 75, 100])[0]).toBeNull();
});

test("iRacing lap progress projects onto official outline when GPS positions are unavailable", () => {
  const outline = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }];
  expect(projectIRacingDistanceToOutline([0, 5, 10], outline)).toEqual([
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
  ]);
});
