import { expect, test } from "bun:test";
import { TrackConfigurationSchema, trackConfigurationCanonicalId, trackConfigurationVenueId } from "../shared/racing/tracks/configuration";
import {
  TrackImageryVenueManifestSchema,
  composeTrackImageryMatrices,
  defaultVenueImageryCalibration,
  geographicTrackImageryPoint,
  resolveTrackImageryMatrix,
  trackImageryCalibrationFromBounds,
  trackImageryGeographicBounds,
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

test("validates hierarchical venue assignments and confirmation provenance", () => {
  const configuration = TrackConfigurationSchema.parse({
    version: 1,
    gameId: "iracing",
    trackOrdinal: 24,
    venue: { id: "daytona", name: "Daytona" },
    subVenues: [
      { id: "historical", name: "Historical" },
      { id: "2011", name: "2011" },
    ],
    track: { id: "road-course", name: "Road Course" },
    confirmation: { confirmedAt: "2026-08-17", confirmedBy: "RaceIQ maintainer", commitId: "abcdef1" },
  });
  expect(trackConfigurationVenueId(configuration)).toBe("daytona/historical/2011");
  expect(trackConfigurationCanonicalId(configuration)).toBe("daytona/historical/2011/road-course");
  expect(TrackConfigurationSchema.safeParse({ ...configuration, subVenues: [{ id: "../", name: "Invalid" }] }).success).toBe(false);
  expect(
    TrackConfigurationSchema.safeParse({
      ...configuration,
      confirmation: { ...configuration.confirmation, confirmedAt: "2026-02-31" },
    }).success,
  ).toBe(false);
});

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
test("calibrates an API raster to its exact geographic bounds", () => {
  const originLatitudeDeg = 29;
  const originLongitudeDeg = -81;
  const geographic = [geographicFromEnu(-200, -100, originLatitudeDeg, originLongitudeDeg), geographicFromEnu(200, 100, originLatitudeDeg, originLongitudeDeg)];
  const bounds = trackImageryGeographicBounds(geographic, 0.1);
  expect(bounds).not.toBeNull();
  const calibration = trackImageryCalibrationFromBounds(geographic, bounds!);
  expect(calibration).not.toBeNull();
  const northWest = geographicTrackImageryPoint({ latitudeDeg: bounds!.north, longitudeDeg: bounds!.west }, calibration!);
  const southEast = geographicTrackImageryPoint({ latitudeDeg: bounds!.south, longitudeDeg: bounds!.east }, calibration!);
  expect(transformTrackImageryPoint(calibration!.imageToEnu, 0, 0)).toEqual(northWest);
  const transformedSouthEast = transformTrackImageryPoint(calibration!.imageToEnu, 1, 1);
  expect(transformedSouthEast.x).toBeCloseTo(southEast.x, 8);
  expect(transformedSouthEast.z).toBeCloseTo(southEast.z, 8);
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
