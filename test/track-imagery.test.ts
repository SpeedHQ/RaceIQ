import { expect, test } from "bun:test";
import {
  TrackImageryVenueManifestSchema,
  composeTrackImageryMatrices,
  defaultVenueImageryCalibration,
  resolveTrackImageryMatrix,
  transformTrackImageryPoint,
  type TrackImageryGeographicPoint,
  type TrackImageryMatrix,
} from "../shared/racing/tracks/imagery";

const EARTH_RADIUS_M = 6_378_137;

function geographicFromEnu(east: number, north: number, originLatitudeDeg: number, originLongitudeDeg: number): TrackImageryGeographicPoint {
  return {
    latitudeDeg: originLatitudeDeg + ((north / EARTH_RADIUS_M) * 180) / Math.PI,
    longitudeDeg: originLongitudeDeg + ((east / (EARTH_RADIUS_M * Math.cos((originLatitudeDeg * Math.PI) / 180))) * 180) / Math.PI,
  };
}

test("creates a north-up venue footprint that fully covers GPS path", () => {
  const originLatitudeDeg = 29;
  const originLongitudeDeg = -81;
  const geographic = [
    geographicFromEnu(-100, -40, originLatitudeDeg, originLongitudeDeg),
    geographicFromEnu(100, -40, originLatitudeDeg, originLongitudeDeg),
    geographicFromEnu(100, 40, originLatitudeDeg, originLongitudeDeg),
    geographicFromEnu(-100, 40, originLatitudeDeg, originLongitudeDeg),
  ];
  const calibration = defaultVenueImageryCalibration(geographic, 2);
  expect(calibration).not.toBeNull();
  const [a, b, c, d] = calibration!.imageToEnu;
  expect(a).toBeGreaterThanOrEqual(200);
  expect(b).toBe(0);
  expect(c).toBe(0);
  expect(d).toBeLessThanOrEqual(-100);
  expect(a / Math.abs(d)).toBeCloseTo(2, 8);
});

test("resolves one GPS-calibrated venue texture into mirrored game-local coordinates", () => {
  const originLatitudeDeg = 29;
  const originLongitudeDeg = -81;
  const enu = [
    { x: -80, z: -30 },
    { x: 80, z: -30 },
    { x: 120, z: 20 },
    { x: 40, z: 90 },
    { x: -90, z: 60 },
  ];
  const geographic = enu.map((point) => geographicFromEnu(point.x, point.z, originLatitudeDeg, originLongitudeDeg));
  const enuToTrack: TrackImageryMatrix = [0, 1.5, 1.5, 0, 400, -120];
  const local = enu.map((point) => transformTrackImageryPoint(enuToTrack, point.x, point.z));
  const imageToEnu: TrackImageryMatrix = [240, 0, 0, -140, -120, 70];
  const resolved = resolveTrackImageryMatrix(local, geographic, { originLatitudeDeg, originLongitudeDeg, imageToEnu });
  expect(resolved).not.toBeNull();
  const expected = composeTrackImageryMatrices(enuToTrack, imageToEnu);
  for (const [u, v] of [
    [0, 0],
    [1, 0],
    [1, 1],
    [0.25, 0.75],
  ] as const) {
    const actualPoint = transformTrackImageryPoint(resolved!, u, v);
    const expectedPoint = transformTrackImageryPoint(expected, u, v);
    expect(actualPoint.x).toBeCloseTo(expectedPoint.x, 4);
    expect(actualPoint.z).toBeCloseTo(expectedPoint.z, 4);
  }
});

test("keeps venue base opaque while layers retain independent alpha", () => {
  const manifest = TrackImageryVenueManifestSchema.parse({
    version: 1,
    venueId: "daytona",
    calibration: { originLatitudeDeg: 29, originLongitudeDeg: -81, imageToEnu: [1, 0, 0, -1, 0, 0] },
    base: { image: "base.webp", opacity: 0.2, source: { name: "Owned base", license: "owned", attribution: "" } },
    layers: [{ id: "road-course", kind: "layout", image: "road-course.webp", opacity: 0.65, source: { name: "Owned correction", license: "owned", attribution: "" } }],
  });
  expect("opacity" in manifest.base).toBe(false);
  expect(manifest.layers[0]?.opacity).toBe(0.65);
});
