import { describe, expect, test } from "bun:test";
import { analyzeLap } from "@shared/lib/lap-insights";
import { initGameAdapters } from "@shared/games/init";
import { MIN_REPORTABLE_LOSS_S } from "@shared/lib/time-loss";
import type { TelemetryPacket } from "@shared/types";

const RADIUS = 0.33;
const STEP_MS = 16;
const STEP_S = STEP_MS / 1000;


initGameAdapters();
interface Frame {
  speed: number;
  accel?: number;
  brake?: number;
  locked?: boolean;
}

/**
 * Builds a lap from a list of phases, each contributing `n` frames. Speed is
 * integrated from the phase's acceleration so the packets stay self-consistent
 * (time-loss estimation reads Speed, TimestampMS and dt together).
 */
function lap(phases: { n: number; a: number; accel: number; brake?: number; locked?: boolean }[], v0 = 40): TelemetryPacket[] {
  const out: TelemetryPacket[] = [];
  let v = v0;
  let t = 0;
  for (const phase of phases) {
    for (let i = 0; i < phase.n; i++) {
      out.push(pkt({ speed: v, accel: phase.accel, brake: phase.brake, locked: phase.locked }, t));
      v = Math.max(1, v + phase.a * STEP_S);
      t += STEP_MS;
    }
  }
  return out;
}

function pkt(f: Frame, t: number): TelemetryPacket {
  const rot = f.speed / RADIUS;
  return {
    TimestampMS: t,
    Speed: f.speed,
    Accel: f.accel ?? 0,
    Brake: f.brake ?? 0,
    Steer: 0,
    WheelRotationSpeedFL: f.locked ? 0 : rot,
    WheelRotationSpeedFR: rot,
    WheelRotationSpeedRL: rot,
    WheelRotationSpeedRR: rot,
  } as unknown as TelemetryPacket;
}

function find(insights: ReturnType<typeof analyzeLap>, id: string) {
  return insights.find((i) => i.id === id);
}

describe("analyzeLap time-loss quantification", () => {
  test("coasting that is not corner entry is charged for the speed it bled", () => {
    const insights = analyzeLap(
      lap([
        // Establish what the car can do: a long clean full-throttle pull.
        { n: 400, a: 4, accel: 255 },
        // Dead time: 1.6 s off both pedals, decelerating on drag.
        { n: 100, a: -2, accel: 0 },
        // Back to power, and never brakes — so this coast is not corner entry.
        { n: 300, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    const coasting = find(insights, "driving-coasting");
    expect(coasting).toBeDefined();
    expect(coasting!.timeLossS).toBeDefined();
    expect(coasting!.timeLossS!).toBeGreaterThanOrEqual(MIN_REPORTABLE_LOSS_S);
    // Cannot cost more than the 1.6 s the coast itself occupied.
    expect(coasting!.timeLossS!).toBeLessThanOrEqual(1.6);
  });

  test("a coast that runs into braking is deliberate corner entry, not charged", () => {
    const insights = analyzeLap(
      lap([
        { n: 400, a: 4, accel: 255 },
        { n: 100, a: -2, accel: 0 },
        // Hard braking immediately after the release.
        { n: 60, a: -12, accel: 0, brake: 200 },
        { n: 200, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    const coasting = find(insights, "driving-coasting");
    expect(coasting).toBeDefined();
    expect(coasting!.timeLossS).toBeUndefined();
  });

  test("detectors that only describe a symptom stay unquantified", () => {
    const insights = analyzeLap(
      lap([
        { n: 400, a: 4, accel: 255 },
        { n: 100, a: -2, accel: 0 },
        { n: 300, a: 4, accel: 255 },
      ]),
      "fm-2023",
    );

    // Whatever else fires on this synthetic lap, no insight may claim a
    // negative or absurd cost, and unquantified must mean absent (not 0).
    for (const i of insights) {
      if (i.timeLossS === undefined) continue;
      expect(i.timeLossS).toBeGreaterThanOrEqual(MIN_REPORTABLE_LOSS_S);
      expect(i.timeLossS).toBeLessThan(13);
    }
  });

  test("a lap too short to analyse yields nothing rather than guesses", () => {
    expect(analyzeLap(lap([{ n: 5, a: 0, accel: 255 }]), "fm-2023")).toEqual([]);
  });
});

describe("analyzeLap wheel-state capabilities", () => {
  function lockedLap(): TelemetryPacket[] {
    return lap([{ n: 20, a: -2, accel: 0, brake: 200, locked: true }], 30);
  }

  test("retains lockup insights when wheel rotation is available", () => {
    const insights = analyzeLap(lockedLap(), "fm-2023");

    expect(find(insights, "tire-lockup-FL")).toBeDefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeDefined();
  });

  test("omits lockup insights when iRacing wheel rotation is unavailable", () => {
    const insights = analyzeLap(lockedLap(), "iracing");

    expect(find(insights, "tire-lockup-FL")).toBeUndefined();
    expect(find(insights, "driving-brake-traction-loss")).toBeUndefined();
  });
});
