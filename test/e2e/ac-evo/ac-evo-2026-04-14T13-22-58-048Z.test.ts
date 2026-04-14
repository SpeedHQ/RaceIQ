/**
 * AC Evo early access (v0.5 shared memory) recording — Porsche 911 GT3 Cup (992)
 *
 * Known AC Evo v0.5 limitations confirmed by offset analysis:
 *   - Graphics timing fields (completedLaps, iCurrentTime, normalizedCarPosition,
 *     distanceTraveled) are all zero — lap detection not possible until fixed upstream
 *   - Tri-zone tire temps (inner/middle/outer) are not exported — single avg only
 *   - tyreTempFL/FR/RL/RR and tyreCoreFL/FR/RL/RR hold the same value
 *   - tc/abs output floats are zero
 *   - padLife/discLife are normalized fractions (0–1), not mm like ACC
 *   - track name is not populated in static
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import type { TelemetryPacket } from "../../../shared/types";
import { readAcEvoPackets, ensureInit } from "../../helpers/parse-dump";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";

const RECORDINGS_DIR = "test/artifacts/laps";
const recordingFile = "ac-evo-2026-04-14T13-22-58-048Z.bin";
const recording = join(RECORDINGS_DIR, recordingFile);

let packets: TelemetryPacket[] = [];
let carModel: string | null = null;
let trackName: string | null = null;

beforeAll(() => {
  if (!existsSync(recording)) return;
  ensureInit();
  const result = readAcEvoPackets(recording);
  packets = result.packets;
  carModel = result.carModel;
  trackName = result.trackName;
});

describe(recordingFile, () => {
  test("parses packets with correct gameId and car", () => {
    if (!existsSync(recording)) return;

    expect(packets.length).toBeGreaterThan(1000);
    expect(packets[0].gameId).toBe("ac-evo");

    // Static buffer populates car display name
    expect(carModel).toBe("Porsche 911 GT3 Cup (992)");

    // AC Evo v0.5 does not populate track in static
    expect(trackName).toBeFalsy();
  });

  test("physics data is live and plausible", () => {
    if (!existsSync(recording)) return;

    const maxSpeed = Math.max(...packets.map((p) => p.Speed));
    const maxRpm = Math.max(...packets.map((p) => p.CurrentEngineRpm));
    const gears = new Set(packets.map((p) => p.Gear));

    // Speed is in m/s — GT3 car should exceed 150 km/h (41.7 m/s)
    expect(maxSpeed).toBeGreaterThan(41);
    // 911 GT3 Cup (992) redline is ~8750 rpm
    expect(maxRpm).toBeGreaterThan(6000);
    expect(maxRpm).toBeLessThan(10000);
    // Multiple gears used across the lap
    expect(gears.size).toBeGreaterThan(3);
  });

  test("tire pressures and temps are populated", () => {
    if (!existsSync(recording)) return;

    // Speed is in m/s — 50 km/h ≈ 13.9 m/s
    const movingPacket = packets.find((p) => p.Speed > 13);
    expect(movingPacket).toBeDefined();

    // Tire pressures should be in a plausible PSI range for GT3
    expect(movingPacket!.TirePressureFrontLeft).toBeGreaterThan(20);
    expect(movingPacket!.TirePressureFrontLeft).toBeLessThan(40);

    // Tire temps should be above ambient
    expect(movingPacket!.TireTempFL).toBeGreaterThan(30);
    // Tri-zone temps not exported by AC Evo v0.5
    expect(movingPacket!.acc?.tireInnerTemp[0]).toBe(0);
  });

  test("graphics timing fields are zero — lap detection pending upstream fix", () => {
    if (!existsSync(recording)) return;

    // AC Evo v0.5 does not write completedLaps, iCurrentTime, or distanceTraveled
    expect(packets.every((p) => p.LapNumber === 0)).toBe(true);
    expect(packets.every((p) => p.CurrentLap === 0)).toBe(true);
    expect(packets.every((p) => p.DistanceTraveled === 0)).toBe(true);
  });

  test("outputs SVG visualization of raw packets", () => {
    if (!existsSync(recording)) return;

    // Subsample to every 5th packet — sufficient detail for track trace, avoids huge SVG
    const sampled = packets.filter((_, i) => i % 5 === 0);
    generateRecordingVisualizations(recordingFile, [], sampled);
  });
});
