import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache, type AcEvoParserCache } from "../server/games/ac-evo/parser";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS } from "../server/games/ac-evo/structs";

/**
 * Physics-rate DistanceTraveled derivation (integrateDistance in parser.ts).
 *
 * AC Evo stores telemetry at ~100Hz but `current_km` (the raw distance source)
 * updates at only 60Hz, so distance-keyed charts would stack ~40% of frames on
 * duplicate x-positions. integrateDistance fills the gaps by integrating speed
 * against the physics packetId clock, re-anchored to current_km each tick.
 */

const M_PER_S_PER_KMH = 1 / 3.6;

function baseBuffers() {
  const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
  // Default status (0) is AC_OFF — parser gates out. AC_LIVE runs the full body.
  graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
  return {
    physics: Buffer.alloc(PHYSICS.SIZE),
    graphics,
    staticData: Buffer.alloc(STATIC_EVO.SIZE),
  };
}

/**
 * Parse one synthetic frame and return its DistanceTraveled (m). Writes only
 * the fields integrateDistance consumes: physics packetId + speedKmh, graphics
 * current_km.
 */
function frame(cache: AcEvoParserCache, packetId: number, speedKmh: number, currentKm: number): number {
  const { physics, graphics, staticData } = baseBuffers();
  physics.writeInt32LE(packetId | 0, PHYSICS.packetId.offset);
  physics.writeFloatLE(speedKmh, PHYSICS.speedKmh.offset);
  graphics.writeFloatLE(currentKm, GRAPHICS_EVO.current_km.offset);
  const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);
  expect(packet).not.toBeNull();
  return packet!.DistanceTraveled;
}

/**
 * Drive a straight at constant speed. `current_km` only ticks every `kmEvery`
 * frames (the 60Hz-into-100Hz stepping), while packetId advances every frame.
 * Returns the DistanceTraveled series plus whether current_km changed on each.
 */
function straight(cache: AcEvoParserCache, opts: { frames: number; speedKmh: number; packetStep: number; kmEvery: number }) {
  const { frames, speedKmh, packetStep, kmEvery } = opts;
  const speedMps = speedKmh * M_PER_S_PER_KMH;
  // True distance per stored frame (assembler ~100Hz, so ~10ms/frame).
  const dtFrame = 0.01;
  const dist: number[] = [];
  const kmChanged: boolean[] = [];
  let km = 0;
  let prevKm = 0;
  let packetId = 1000;
  for (let i = 0; i < frames; i++) {
    // current_km advances continuously, but is only *observed* every kmEvery
    // frames (holds its previous value in between — the 60Hz quantization).
    km += speedMps * dtFrame / 1000; // km
    const observedKm = i % kmEvery === 0 ? km : prevKm;
    if (i % kmEvery === 0) prevKm = km;
    dist.push(frame(cache, packetId, speedKmh, observedKm));
    kmChanged.push(i % kmEvery === 0);
    packetId += packetStep;
  }
  return { dist, kmChanged };
}

describe("AC Evo integrateDistance — physics-rate DistanceTraveled", () => {
  test("monotonic, and strictly increasing on frames where current_km is unchanged (the core fix)", () => {
    const cache = createAcEvoParserCache();
    const { dist, kmChanged } = straight(cache, { frames: 120, speedKmh: 180, packetStep: 3, kmEvery: 5 });

    // Never decreases anywhere.
    for (let i = 1; i < dist.length; i++) {
      expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    }

    // On frames where current_km did NOT change, distance must still advance —
    // this is exactly the stepping that made charts look sub-100Hz. Only check
    // after calibration has warmed up (skip the first current_km interval).
    let advancedOnHeldFrames = 0;
    let heldFrames = 0;
    for (let i = 12; i < dist.length; i++) {
      if (!kmChanged[i]) {
        heldFrames++;
        if (dist[i] > dist[i - 1]) advancedOnHeldFrames++;
      }
    }
    expect(heldFrames).toBeGreaterThan(0);
    // Every held frame at non-zero speed should advance.
    expect(advancedOnHeldFrames).toBe(heldFrames);
  });

  test("stays near the current_km ground-truth anchor (bounded drift)", () => {
    const cache = createAcEvoParserCache();
    const speedKmh = 180;
    const speedMps = speedKmh * M_PER_S_PER_KMH;
    straight(cache, { frames: 60, speedKmh, packetStep: 3, kmEvery: 5 });
    // After warmup, emitted distance tracks current_km*1000 within roughly one
    // 60Hz observation interval of travel (~5 frames * 10ms * 50 m/s = ~25 m,
    // generous bound covering the pre-observation hold).
    const km = 5.0;
    const d = frame(cache, 2000, speedKmh, km);
    const maxDriftM = speedMps * 0.01 * 6; // ~6 frames of travel
    expect(Math.abs(d - km * 1000)).toBeLessThan(maxDriftM + 1);
  });

  test("calibrates k into the valid clamp window", () => {
    const cache = createAcEvoParserCache();
    straight(cache, { frames: 60, speedKmh: 200, packetStep: 3, kmEvery: 5 });
    expect(cache._distK).toBeGreaterThanOrEqual(1 / 1000);
    expect(cache._distK).toBeLessThanOrEqual(1 / 100);
    expect(cache._distK).toBeGreaterThan(0);
  });

  test("lap reset: current_km dropping to ~0 drops DistanceTraveled by a full lap and resumes monotonic", () => {
    const cache = createAcEvoParserCache();
    // Build up distance across a lap.
    let packetId = 1000;
    let last = 0;
    for (let i = 0; i < 40; i++) {
      last = frame(cache, packetId, 180, 1.0 + i * 0.05); // ramps 1.0 → ~3.0 km
      packetId += 3;
    }
    expect(last).toBeGreaterThan(2500);

    // New lap: current_km resets to ~0.
    const afterReset = frame(cache, packetId, 180, 0.01);
    expect(last - afterReset).toBeGreaterThan(100); // dropped well past lap-split threshold
    expect(afterReset).toBeLessThan(100);

    // Resumes monotonic from the fresh anchor.
    packetId += 3;
    const next = frame(cache, packetId, 180, 0.02);
    expect(next).toBeGreaterThanOrEqual(afterReset);
  });

  test("stationary car (speed 0) holds distance constant even as packetId advances", () => {
    const cache = createAcEvoParserCache();
    // Warm up so we're past the fallback, then sit still.
    straight(cache, { frames: 30, speedKmh: 150, packetStep: 3, kmEvery: 5 });
    let packetId = 5000;
    const km = 2.0;
    const d0 = frame(cache, packetId, 0, km);
    for (let i = 0; i < 10; i++) {
      packetId += 3;
      const d = frame(cache, packetId, 0, km);
      expect(d).toBeCloseTo(d0, 3);
    }
  });

  test("duplicate packetId yields identical output and never NaN", () => {
    const cache = createAcEvoParserCache();
    straight(cache, { frames: 30, speedKmh: 160, packetStep: 3, kmEvery: 5 });
    const d1 = frame(cache, 9000, 160, 3.0);
    const d2 = frame(cache, 9000, 160, 3.0); // same packetId → no integration step
    expect(Number.isNaN(d1)).toBe(false);
    expect(Number.isNaN(d2)).toBe(false);
    expect(d2).toBe(d1);
  });
});
