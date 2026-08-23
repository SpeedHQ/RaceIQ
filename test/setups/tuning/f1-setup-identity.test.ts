import { describe, test, expect } from "bun:test";
import { f1SetupFingerprint, resolveLapF1Setup, summarizeF1Setup } from "../../../server/ai/f1-setup-identity";
import type { F1CarSetup } from "../../../shared/telemetry/f1-2025";

function baseSetup(overrides: Partial<F1CarSetup> = {}): F1CarSetup {
  return {
    frontWing: 25,
    rearWing: 30,
    onThrottle: 55,
    offThrottle: 65,
    frontCamber: -3.0,
    rearCamber: -1.5,
    frontToe: 0.05,
    rearToe: 0.1,
    frontSuspension: 5,
    rearSuspension: 6,
    frontAntiRollBar: 5,
    rearAntiRollBar: 6,
    frontRideHeight: 30,
    rearRideHeight: 45,
    brakePressure: 90,
    brakeBias: 55,
    engineBraking: 50,
    rearLeftTyrePressure: 22.5,
    rearRightTyrePressure: 22.5,
    frontLeftTyrePressure: 23.0,
    frontRightTyrePressure: 23.0,
    fuelLoad: 50,
    ...overrides,
  };
}

describe("f1SetupFingerprint", () => {
  test("ignores fuelLoad differences", () => {
    const a = baseSetup({ fuelLoad: 50 });
    const b = baseSetup({ fuelLoad: 10 });
    expect(f1SetupFingerprint(a)).toBe(f1SetupFingerprint(b));
  });

  test("ignores tyre pressure noise within 1 decimal rounding", () => {
    const a = baseSetup({ frontLeftTyrePressure: 23.0 });
    const b = baseSetup({ frontLeftTyrePressure: 23.03 });
    expect(f1SetupFingerprint(a)).toBe(f1SetupFingerprint(b));
  });

  test("differs when frontWing changes", () => {
    const a = baseSetup({ frontWing: 25 });
    const b = baseSetup({ frontWing: 26 });
    expect(f1SetupFingerprint(a)).not.toBe(f1SetupFingerprint(b));
  });
});

describe("resolveLapF1Setup", () => {
  test("reads persisted carSetup metadata", () => {
    const setup = baseSetup();
    expect(resolveLapF1Setup(JSON.stringify(setup))).toEqual(setup);
  });

  test("keeps unavailable and malformed setup metadata unavailable", () => {
    expect(resolveLapF1Setup(null)).toBeNull();
    expect(resolveLapF1Setup("{not-json")).toBeNull();
  });
});

describe("summarizeF1Setup", () => {
  test("returns a non-empty string mentioning the wing values", () => {
    const s = baseSetup({ frontWing: 25, rearWing: 30 });
    const summary = summarizeF1Setup(s);
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).toContain("FW25");
    expect(summary).toContain("RW30");
  });
});
