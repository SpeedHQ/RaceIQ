import { describe, test, expect } from "bun:test";
import { parseAcEvoBuffers, createAcEvoParserCache, type AcEvoParserCache } from "../server/games/ac-evo/parser";
import { PHYSICS, GRAPHICS_EVO, STATIC_EVO, ACEVO_STATUS } from "../server/games/ac-evo/structs";
import { fillNormSuspension } from "../server/telemetry-utils";
import type { TelemetryPacket } from "../shared/types";

/**
 * Suspension rest calibration (calibrateSuspRest in parser.ts).
 *
 * AC Evo's suspTravel channel is signed but not zero-centred on ride height —
 * real recordings idle anywhere from -36 mm to +2 mm depending on car/setup. The
 * parser learns the rest height from the car's own idle frames so a stationary
 * car reads 0.5 (mid-bar) instead of landing in the UI's red zone.
 */

const IDLE_FRAMES = 30; // must match SUSP_IDLE_FRAMES
const MOVING_FRAMES = 600; // must match SUSP_MOVING_FRAMES
const RANGE_M = 0.025; // must match SUSP_RANGE_M

type Corners = [number, number, number, number];

/** Parse one synthetic frame at `speedKmh` with the given per-corner travel (m). */
function frame(cache: AcEvoParserCache, speedKmh: number, travel: Corners): TelemetryPacket {
  const physics = Buffer.alloc(PHYSICS.SIZE);
  const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
  const staticData = Buffer.alloc(STATIC_EVO.SIZE);
  // Default status (0) is AC_OFF — the parser gates out. AC_LIVE runs the body.
  graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
  physics.writeFloatLE(speedKmh, PHYSICS.speedKmh.offset);
  physics.writeFloatLE(travel[0], PHYSICS.suspTravelFL.offset);
  physics.writeFloatLE(travel[1], PHYSICS.suspTravelFR.offset);
  physics.writeFloatLE(travel[2], PHYSICS.suspTravelRL.offset);
  physics.writeFloatLE(travel[3], PHYSICS.suspTravelRR.offset);
  const packet = parseAcEvoBuffers(physics, graphics, staticData, cache);
  expect(packet).not.toBeNull();
  return packet!;
}

function norms(p: TelemetryPacket): Corners {
  return [
    p.NormSuspensionTravelFL,
    p.NormSuspensionTravelFR,
    p.NormSuspensionTravelRL,
    p.NormSuspensionTravelRR,
  ];
}

/** Feed `n` stationary frames at `travel`; returns the last packet. */
function idle(cache: AcEvoParserCache, travel: Corners, n = IDLE_FRAMES): TelemetryPacket {
  let p!: TelemetryPacket;
  for (let i = 0; i < n; i++) p = frame(cache, 0, travel);
  return p;
}

// Real measured idle offsets (metres) — a car that the old fixed encoding put
// deep in the red (FL -36 mm ⇒ 0.5 - 0.36 = 0.14) and one it put near-neutral.
const OFFSET_CAR: Corners = [-0.036, -0.035, -0.017, -0.017];
const NEUTRAL_CAR: Corners = [-0.011, -0.010, 0.002, 0.002];

describe("AC Evo suspension rest calibration", () => {
  test("a stationary car reads mid-bar regardless of its channel offset", () => {
    for (const rest of [OFFSET_CAR, NEUTRAL_CAR, [0, 0, 0, 0] as Corners]) {
      const cache = createAcEvoParserCache();
      const p = idle(cache, rest);
      for (const n of norms(p)) expect(n).toBeCloseTo(0.5, 5);
    }
  });

  test("before enough idle frames the bar is uncalibrated, not garbage", () => {
    const cache = createAcEvoParserCache();
    // One frame in: rest is still 0, so we fall back to raw-channel centring.
    // The point is it stays inside the bar rather than NaN/out-of-range.
    const p = frame(cache, 0, OFFSET_CAR);
    for (const n of norms(p)) {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  test("deflection from rest maps symmetrically around 0.5", () => {
    const cache = createAcEvoParserCache();
    idle(cache, OFFSET_CAR);

    // Compress every corner by half the range ⇒ 0.75; extend ⇒ 0.25. Frames are
    // fed at speed so the baseline is frozen and cannot absorb the deflection.
    const half = RANGE_M / 2;
    const bump = OFFSET_CAR.map((v) => v + half) as Corners;
    const droop = OFFSET_CAR.map((v) => v - half) as Corners;
    for (const n of norms(frame(cache, 60, bump))) expect(n).toBeCloseTo(0.75, 4);
    for (const n of norms(frame(cache, 60, droop))) expect(n).toBeCloseTo(0.25, 4);

    // Beyond ±RANGE_M it clamps to the ends of the bar.
    const slam = OFFSET_CAR.map((v) => v + RANGE_M * 3) as Corners;
    const lift = OFFSET_CAR.map((v) => v - RANGE_M * 3) as Corners;
    for (const n of norms(frame(cache, 60, slam))) expect(n).toBe(1);
    for (const n of norms(frame(cache, 60, lift))) expect(n).toBe(0);
  });

  test("front/rear rake is preserved — corners calibrate independently", () => {
    const cache = createAcEvoParserCache();
    idle(cache, OFFSET_CAR);
    // Dive: fronts compress by 40% of the range, rears extend by 20% of it.
    const front = RANGE_M * 0.4;
    const rear = RANGE_M * 0.2;
    const dive: Corners = [
      OFFSET_CAR[0] + front,
      OFFSET_CAR[1] + front,
      OFFSET_CAR[2] - rear,
      OFFSET_CAR[3] - rear,
    ];
    const [fl, fr, rl, rr] = norms(frame(cache, 60, dive));
    expect(fl).toBeCloseTo(0.5 + front / (2 * RANGE_M), 4);
    expect(fr).toBeCloseTo(0.5 + front / (2 * RANGE_M), 4);
    expect(rl).toBeCloseTo(0.5 - rear / (2 * RANGE_M), 4);
    expect(rr).toBeCloseTo(0.5 - rear / (2 * RANGE_M), 4);
  });

  test("the idle baseline is frozen once the car drives away", () => {
    const cache = createAcEvoParserCache();
    idle(cache, OFFSET_CAR);

    // Drive for a long time with a *heavily* compressed, perfectly steady
    // suspension (a downforce-loaded flat-out stint). The moving-frame fallback
    // must not kick in and re-baseline to this, or every lap would read 0.5.
    const squat = RANGE_M * 0.6;
    const expected = 0.5 + squat / (2 * RANGE_M);
    const loaded = OFFSET_CAR.map((v) => v + squat) as Corners;
    let p!: TelemetryPacket;
    for (let i = 0; i < MOVING_FRAMES * 2; i++) p = frame(cache, 150, loaded);
    for (const n of norms(p)) expect(n).toBeCloseTo(expected, 4);

    // Returning to a standstill must not move it either.
    for (const n of norms(idle(cache, loaded, IDLE_FRAMES * 2))) expect(n).toBeCloseTo(expected, 4);
  });

  test("a session joined mid-lap falls back to the moving mean", () => {
    const cache = createAcEvoParserCache();
    // Never stationary: oscillate symmetrically about the true rest height.
    let p!: TelemetryPacket;
    for (let i = 0; i < MOVING_FRAMES; i++) {
      const wobble = (i % 2 === 0 ? 1 : -1) * 0.012;
      p = frame(cache, 120, OFFSET_CAR.map((v) => v + wobble) as Corners);
    }
    // Mean of the oscillation == rest, so the final frame (an extension half of
    // the wobble) sits one wobble below centre, rather than being pinned to an
    // arbitrary channel zero.
    const expected = 0.5 - 0.012 / (2 * RANGE_M);
    for (const n of norms(p)) expect(n).toBeCloseTo(expected, 3);
  });

  test("swapping cars re-calibrates instead of reusing the old height", () => {
    const cache = createAcEvoParserCache();
    idle(cache, OFFSET_CAR);
    // Same buffers, but a new car_model string ⇒ baseline must be discarded.
    const physics = Buffer.alloc(PHYSICS.SIZE);
    const graphics = Buffer.alloc(GRAPHICS_EVO.SIZE);
    graphics.writeInt32LE(ACEVO_STATUS.AC_LIVE, GRAPHICS_EVO.status.offset);
    graphics.write("some_other_car\0", GRAPHICS_EVO.car_model.offset, "utf8");
    for (const [i, off] of [
      PHYSICS.suspTravelFL.offset,
      PHYSICS.suspTravelFR.offset,
      PHYSICS.suspTravelRL.offset,
      PHYSICS.suspTravelRR.offset,
    ].entries()) {
      physics.writeFloatLE(NEUTRAL_CAR[i]!, off);
    }
    parseAcEvoBuffers(physics, graphics, Buffer.alloc(STATIC_EVO.SIZE), cache);

    // Old rest (OFFSET_CAR) is gone; the new car's idle becomes the baseline.
    for (const n of norms(idle(cache, NEUTRAL_CAR))) expect(n).toBeCloseTo(0.5, 5);
  });

  test("fillNormSuspension does not overwrite the parser's calibration", () => {
    const cache = createAcEvoParserCache();
    idle(cache, OFFSET_CAR);
    // Fully extended relative to rest ⇒ a legitimate 0.0, with positive
    // absolute travel. The pipeline must leave it alone.
    const p = frame(cache, 60, OFFSET_CAR.map(() => 0.02) as Corners);
    const before = norms(p);
    fillNormSuspension(p);
    expect(norms(p)).toEqual(before);
  });
});
