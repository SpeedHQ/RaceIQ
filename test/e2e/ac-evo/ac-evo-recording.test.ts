/**
 * AC Evo v0.6 shared memory recording smoke test.
 *
 * Globs the latest ac-evo-*.bin in test/artifacts/laps and validates the v0.6
 * parser against it. Skipped if no recording exists.
 *
 * v0.6 confirmed working (via `Local\acevo_pmf_*` mappings, not ACC's acpmf_*):
 *   - Physics live at ~300 Hz (speed, rpm, gear, tire temps, pressures)
 *   - Graphics live at ~60 Hz (status, lap times, npos, car_model)
 *   - Static may be empty in solo/time-attack sessions — session=-1 (AC_UNKNOWN)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { readdirSync, existsSync } from "fs";
import { join } from "path";
import type { TelemetryPacket } from "../../../shared/types";
import type { CapturedLap } from "../../../server/pipeline-adapters";
import { readAcEvoPackets, parseDump, ensureInit } from "../../helpers/parse-dump";
import { generateRecordingVisualizations } from "../../helpers/lap-viz";

const RECORDINGS_DIR = "test/artifacts/laps";

function findLatestAcEvoBin(): string | null {
  if (!existsSync(RECORDINGS_DIR)) return null;
  const files = readdirSync(RECORDINGS_DIR)
    .filter((f) => f.startsWith("ac-evo-") && f.endsWith(".bin"))
    .sort()
    .reverse();
  return files[0] ? join(RECORDINGS_DIR, files[0]) : null;
}

const recording = findLatestAcEvoBin();

let packets: TelemetryPacket[] = [];
let carModel: string | null = null;
let trackName: string | null = null;
let laps: CapturedLap[] = [];

beforeAll(async () => {
  if (!recording) return;
  ensureInit();
  const result = readAcEvoPackets(recording);
  packets = result.packets;
  carModel = result.carModel;
  trackName = result.trackName;
  // Also run through the full pipeline so we get lap detection + outlap/inlap classification
  const dump = await parseDump("ac-evo", recording);
  laps = dump.laps;
});

describe("AC Evo v0.6 recording", () => {
  test("parses packets with correct gameId", () => {
    if (!recording) return;
    expect(packets.length).toBeGreaterThan(100);
    expect(packets[0].gameId).toBe("ac-evo");
  });

  test("car model resolved from graphics page", () => {
    if (!recording) return;
    // v0.6 puts car_model in GRAPHICS_EVO (char[33] at offset 3086), not STATIC
    expect(carModel).toBeTruthy();
    expect(carModel!.length).toBeGreaterThan(3);
  });

  test("static page may be empty in solo sessions — that's expected", () => {
    if (!recording) return;
    // Time attack / free practice leaves STATIC_EVO largely unpopulated.
    // Track name comes from the pipeline's track ordinal lookup, not static.
    // Just assert we don't throw — null is acceptable.
    expect(trackName === null || typeof trackName === "string").toBe(true);
  });

  test("physics: speed, rpm, gear all live and plausible", () => {
    if (!recording) return;
    const maxSpeed = Math.max(...packets.map((p) => p.Speed));
    const maxRpm = Math.max(...packets.map((p) => p.CurrentEngineRpm));
    const gears = new Set(packets.map((p) => p.Gear));
    // Speed in m/s — GT3 easily exceeds 40 m/s (144 km/h)
    expect(maxSpeed).toBeGreaterThan(30);
    expect(maxRpm).toBeGreaterThan(4000);
    expect(maxRpm).toBeLessThan(12000);
    expect(gears.size).toBeGreaterThan(2);
  });

  test("tire pressures and temps populated", () => {
    if (!recording) return;
    const movingPacket = packets.find((p) => p.Speed > 13);
    expect(movingPacket).toBeDefined();
    expect(movingPacket!.TirePressureFrontLeft).toBeGreaterThan(15);
    expect(movingPacket!.TirePressureFrontLeft).toBeLessThan(50);
    expect(movingPacket!.TireTempFL).toBeGreaterThan(20);
  });

  test("lap timing: current_lap_time_ms ticks up during a lap", () => {
    if (!recording) return;
    // CurrentLap is derived from current_lap_time_ms (offset 188) / 1000
    const lapTimes = packets.map((p) => p.CurrentLap).filter((t) => t > 0);
    expect(lapTimes.length).toBeGreaterThan(100);
    // Max current lap time should be at least 30s (a real lap)
    expect(Math.max(...lapTimes)).toBeGreaterThan(30);
  });

  test("npos (normalized track position) ramps 0→1", () => {
    if (!recording) return;
    const nposValues = packets
      .map((p) => (p.acc as { normalizedCarPosition?: number })?.normalizedCarPosition)
      .filter((v): v is number => typeof v === "number" && v > 0);
    expect(nposValues.length).toBeGreaterThan(100);
    const maxNpos = Math.max(...nposValues);
    expect(maxNpos).toBeGreaterThan(0.5); // driver got at least halfway round a lap
    expect(maxNpos).toBeLessThanOrEqual(1.0);
  });

  test("status is AC_LIVE (2) during recorded session", () => {
    if (!recording) return;
    // IsRaceOn=1 is derived from status===2 in parser
    const liveCount = packets.filter((p) => p.IsRaceOn === 1).length;
    // Majority of recorded frames should be live
    expect(liveCount / packets.length).toBeGreaterThan(0.5);
  });

  test("lap detection: first lap is outlap, final lap is inlap", () => {
    if (!recording) return;
    expect(laps.length).toBeGreaterThanOrEqual(2);
    // Log what we got for debugging
    for (const l of laps) {
      console.log(
        `  lap ${l.lapNumber}: ${(l.lapTime / 1).toFixed(3)}s ${l.isValid ? "valid" : "invalid"}${l.invalidReason ? ` (${l.invalidReason})` : ""}`,
      );
    }
    // First lap: driver exits the pit → outlap (started inside pit, ended on track)
    expect(laps[0].invalidReason).toBe("outlap");
    expect(laps[0].isValid).toBe(false);
    // Final lap: driver enters the pit → inlap (started on track, ended inside pit).
    // Accept either "inlap" or "incomplete" if the recording was stopped mid-lap
    // before the driver actually entered the pit.
    const last = laps[laps.length - 1];
    expect(last.invalidReason === "inlap" || last.invalidReason === "incomplete").toBe(true);
  });

  test("outputs SVG visualization", () => {
    if (!recording) return;
    const sampled = packets.filter((_, i) => i % 10 === 0);
    generateRecordingVisualizations(recording.split(/[\\/]/).pop()!, laps, sampled);
  });
});
