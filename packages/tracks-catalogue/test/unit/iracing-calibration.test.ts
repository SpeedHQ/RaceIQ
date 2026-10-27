import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { fitIRacingSimilarity, iracingGeometryHash, isValidIRacingTrackCalibration, persistIRacingCalibration, readPersistedIRacingCalibration, usableIRacingTelemetryValue } from "../../server/iracing-calibration";
import type { IRacingTrackCalibration } from "@raceiq/shared/racing/tracks/geometry/iracing-reference";
import type { IRacingSvgTrackMap } from "@raceiq/game-iracing/track-map-svg";

const map: IRacingSvgTrackMap = {
  points: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }],
  labels: [], pitLines: [], startFinishAligned: true, forwardDirectionKnown: true, ribbonEdges: null,
};
const geometryHash = "a".repeat(64);
const calibration: IRacingTrackCalibration = {
  source: "recorded-reference", referenceLapId: 29, geometryHash,
  origin: { latitude: 44, longitude: -1, altitude: 12 },
  alignment: { scale: 1, cos: 1, sin: 0, tx: 0, tz: 0, flipX: false, flipZ: false },
  elevationsM: [0, 1, 2], meanErrorM: 4,
};

test("iRacing geometry identity includes native layout and exact source geometry", () => {
  const projection = [...map.points, map.points[0]!];
  const hash = iracingGeometryHash("123", map, projection);
  expect(iracingGeometryHash("123", map, projection)).toBe(hash);
  expect(iracingGeometryHash("124", map, projection)).not.toBe(hash);
  expect(iracingGeometryHash("123", { ...map, points: [...map.points, { x: 1, z: 2 }] }, projection)).not.toBe(hash);
  expect(iracingGeometryHash("123", map, [...projection, { x: 2, z: 4 }])).not.toBe(hash);
});
test("native semantic samples reject non-ok or stale observations", () => {
  expect(usableIRacingTelemetryValue({ values: [{ semanticId: "motion.latitude", value: 44, state: "ok", freshness: "fresh" }] }, "motion.latitude")).toBe(44);
  expect(usableIRacingTelemetryValue({ values: [{ semanticId: "motion.latitude", value: 44, state: "stale", freshness: "fresh" }] }, "motion.latitude")).toBeNull();
  expect(usableIRacingTelemetryValue({ values: [{ semanticId: "motion.latitude", value: 44, state: "ok", freshness: "unknown" }] }, "motion.latitude")).toBeNull();
  expect(usableIRacingTelemetryValue({ values: [{ semanticId: "motion.latitude", value: 44, state: "missing", freshness: "stale" }] }, "motion.latitude")).toBeNull();
});

test("persisted calibration validation rejects stale, malformed, unreasonable, and mismatched artifacts", () => {
  expect(isValidIRacingTrackCalibration(calibration, geometryHash, 3)).toBe(true);
  expect(isValidIRacingTrackCalibration(calibration, "b".repeat(64), 3)).toBe(false);
  expect(isValidIRacingTrackCalibration({ ...calibration, alignment: { ...calibration.alignment, tx: Number.NaN } }, geometryHash, 3)).toBe(false);
  expect(isValidIRacingTrackCalibration({ ...calibration, alignment: { ...calibration.alignment, scale: 100 } }, geometryHash, 3)).toBe(false);
  expect(isValidIRacingTrackCalibration({ ...calibration, alignment: { ...calibration.alignment, cos: 0, sin: 0 } }, geometryHash, 3)).toBe(false);
  expect(isValidIRacingTrackCalibration({ ...calibration, elevationsM: [0, 1] }, geometryHash, 3)).toBe(false);
  expect(isValidIRacingTrackCalibration({ ...calibration, origin: { latitude: 0, longitude: 0, altitude: 0 } }, geometryHash, 3)).toBe(false);
});

test("calibration persists across reload and competing publication cannot replace first artifact", () => {
  const directory = mkdtempSync(join(tmpdir(), "iracing-calibration-"));
  try {
    const saved = persistIRacingCalibration("123", calibration, 3, directory);
    expect(saved).toEqual(calibration);
    expect(readPersistedIRacingCalibration("123", geometryHash, 3, directory)).toEqual(calibration);
    const replacement = { ...calibration, referenceLapId: 32, alignment: { ...calibration.alignment, tx: 50 } };
    expect(persistIRacingCalibration("123", replacement, 3, directory)).toEqual(calibration);
    expect(readPersistedIRacingCalibration("123", geometryHash, 3, directory)).toEqual(calibration);
    const path = join(directory, "iracing-calibrations", `123-${geometryHash}.json`);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(calibration);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("invalid cache and failed persistence never return an in-memory calibration", () => {
  const directory = mkdtempSync(join(tmpdir(), "iracing-calibration-failure-"));
  try {
    const cacheDirectory = join(directory, "iracing-calibrations");
    const cachePath = join(cacheDirectory, `123-${geometryHash}.json`);
    const cached = persistIRacingCalibration("123", calibration, 3, directory);
    expect(cached).toEqual(calibration);
    writeFileSync(cachePath, "{\"unexpected\":true}");
    expect(readPersistedIRacingCalibration("123", geometryHash, 3, directory)).toBeNull();
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    expect(persistIRacingCalibration("123", calibration, 3, blocked)).toBeNull();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixed similarity registration recovers one reflected rotated and scaled transform without altering inputs", () => {
  const source = [{ x: 1, z: 2 }, { x: 8, z: 1 }, { x: 6, z: 9 }, { x: -2, z: 5 }, { x: 4, z: -3 }];
  const expected = { scale: 1.7, cos: Math.cos(0.42), sin: Math.sin(0.42), tx: 125, tz: -48 };
  const target = source.map(({ x, z }) => {
    const reflectedX = -x;
    return { x: expected.scale * (expected.cos * reflectedX - expected.sin * z) + expected.tx, z: expected.scale * (expected.sin * reflectedX + expected.cos * z) + expected.tz };
  });
  const untouched = structuredClone(source);
  const fit = fitIRacingSimilarity(source, target, true, false);
  expect(fit).not.toBeNull();
  expect(fit!.scale).toBeCloseTo(expected.scale, 10);
  expect(fit!.cos).toBeCloseTo(expected.cos, 10);
  expect(fit!.sin).toBeCloseTo(expected.sin, 10);
  expect(fit!.tx).toBeCloseTo(expected.tx, 10);
  expect(fit!.tz).toBeCloseTo(expected.tz, 10);
  expect(fit!.error).toBeCloseTo(0, 10);
  expect(source).toEqual(untouched);
  expect(fitIRacingSimilarity(source.slice(0, 1), target.slice(0, 1), false, false)).toBeNull();
});
