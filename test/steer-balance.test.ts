import { describe, test, expect } from "bun:test";
import { steerBalance } from "../client/src/lib/vehicle-dynamics";
import type { TelemetryPacket } from "../shared/types";

const DEG = Math.PI / 180;
const G = 9.81;

// Minimal packet factory — only the fields steerBalance() reads.
function pkt(o: {
  speedKph: number;
  latG: number;        // right-positive (mirrored to AccelerationX = -latG*G)
  yawRate?: number;    // rad/s — defaults to steady-state (Ay/V)
  frontSlipDeg: number;
  rearSlipDeg: number;
}): TelemetryPacket {
  const speed = o.speedKph / 3.6;
  const yawRate = o.yawRate ?? (Math.abs(o.latG) * G) / Math.max(speed, 0.1);
  return {
    Speed: speed,
    AccelerationX: -o.latG * G,
    AngularVelocityY: yawRate,
    TireSlipAngleFL:  o.frontSlipDeg * DEG,
    TireSlipAngleFR:  o.frontSlipDeg * DEG,
    TireSlipAngleRL:  o.rearSlipDeg  * DEG,
    TireSlipAngleRR:  o.rearSlipDeg  * DEG,
  } as unknown as TelemetryPacket;
}

describe("steerBalance", () => {
  // ── Clear cases ───────────────────────────────────────────────────

  test("clear understeer: front slip >> rear, signals agree", () => {
    const b = steerBalance(pkt({ speedKph: 120, latG: 1.2, frontSlipDeg: 10, rearSlipDeg: 2 }));
    expect(b.state).toBe("understeer");
    expect(b.balance).toBeGreaterThan(0.5);
    expect(b.signalsAgree).toBe(true);
  });

  test("clear oversteer: rear slip >> front, yaw over-rotating", () => {
    const speed = 80;
    const latG = 1.0;
    // Yaw rate 2× the expected path curvature → body rotating fast → oversteer
    const yawRate = 2 * (latG * G) / (speed / 3.6);
    const b = steerBalance(pkt({ speedKph: speed, latG, frontSlipDeg: 2, rearSlipDeg: 11, yawRate }));
    expect(b.state).toBe("oversteer");
    expect(b.balance).toBeLessThan(-0.3);
  });

  test("neutral: matched slip angles, on-path yaw rate", () => {
    const b = steerBalance(pkt({ speedKph: 100, latG: 0.8, frontSlipDeg: 5, rearSlipDeg: 5 }));
    expect(b.state).toBe("neutral");
    expect(Math.abs(b.balance)).toBeLessThan(0.3);
  });

  // ── High-speed yaw conflict (original bug) ────────────────────────
  // At 263 km/h with 0.45g lateral, yawRatePath ≈ 0.06 rad/s.
  // Any real yaw rate looks huge relative to that, driving uYaw strongly
  // negative even when slip angles clearly say understeer.
  // Fix: when signals disagree, trust slip angle alone.

  test("high-speed corner: slip says understeer, yaw says oversteer → slip wins", () => {
    const b = steerBalance(pkt({
      speedKph: 263,
      latG: 0.45,
      frontSlipDeg: 6.3,
      rearSlipDeg:  4.0,
      yawRate: 0.5,   // far above the ~0.06 path yaw → uYaw strongly negative
    }));
    expect(b.signalsAgree).toBe(false);
    expect(b.state).toBe("understeer");
    expect(b.balance).toBeGreaterThan(0);
  });

  // ── Low lat-g gate (previously blocked) ──────────────────────────
  // Old code gated the whole classification at |latG| < 0.25g.
  // Slip angle is a direct tire measurement — doesn't need the gate.

  test("lat-g just below old gate (0.23g) with large slip delta → still classified", () => {
    // From real session: 263 km/h, lat-g 0.23, front 8.5° rear 3.4°
    const b = steerBalance(pkt({ speedKph: 263, latG: 0.23, frontSlipDeg: 8.5, rearSlipDeg: 3.4 }));
    expect(b.state).toBe("understeer");
    expect(b.balance).toBeGreaterThan(0.3);
  });

  test("lat-g below gate with small slip delta → neutral (not enough signal)", () => {
    // Small slips on a gentle sweeper — shouldn't force a classification
    const b = steerBalance(pkt({ speedKph: 200, latG: 0.18, frontSlipDeg: 2, rearSlipDeg: 1.5 }));
    expect(b.state).toBe("neutral");
  });

  // ── Speed gate ────────────────────────────────────────────────────

  test("stationary / very slow → neutral regardless of slip angles", () => {
    const b = steerBalance(pkt({ speedKph: 5, latG: 0.5, frontSlipDeg: 10, rearSlipDeg: 0 }));
    expect(b.state).toBe("neutral");
    expect(b.balance).toBe(0);
  });

  // ── Straight-line cases ───────────────────────────────────────────

  test("straight-line braking: small incidental slip angles → neutral", () => {
    // Lat-g gated, small slips — should not classify as anything
    const b = steerBalance(pkt({ speedKph: 200, latG: 0.05, frontSlipDeg: 2, rearSlipDeg: 1 }));
    expect(b.state).toBe("neutral");
  });

  // ── Trail-braking zone ────────────────────────────────────────────
  // 190 km/h, 100% brake, front slip 6° > rear 3.25°.
  // Front overloaded by combined braking + cornering → understeer is real.

  test("trail-braking: front slip > rear under heavy braking → understeer", () => {
    const b = steerBalance(pkt({ speedKph: 190, latG: 0.31, frontSlipDeg: 6.0, rearSlipDeg: 3.25 }));
    expect(b.state).toBe("understeer");
  });
});
