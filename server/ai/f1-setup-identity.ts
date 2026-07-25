import type { F1CarSetup, TelemetryPacket } from "../../shared/types";

/**
 * Setup-identity helpers for F1 2025 "Add laps from history" auto-sort
 * (docs/setup-engineer-flow-design.md §Phase 6 follow-up): each F1 lap
 * carries its own in-car setup, so instead of a manual target the import
 * groups laps by a canonical fingerprint of that setup — laps that only
 * differ by fuel load or tyre-pressure noise are treated as the same setup.
 */

/** Parse a stored carSetup JSON blob, returning null on any error or shape mismatch. */
function safeParseF1Setup(raw: string): F1CarSetup | null {
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v !== null ? (v as F1CarSetup) : null;
  } catch {
    return null;
  }
}

/** Scan telemetry packets for the first `f1.setup` object. */
export function firstPacketF1Setup(packets: TelemetryPacket[]): F1CarSetup | null {
  for (const p of packets) {
    const s = p.f1?.setup;
    if (s && typeof s === "object") return s as unknown as F1CarSetup;
  }
  return null;
}

/**
 * Resolve the setup for a lap: prefer the stored `carSetup` snapshot, falling
 * back to the first telemetry packet's `f1.setup` when the snapshot is
 * missing (older laps predate the column, or the packet write raced the
 * lap-complete write).
 */
export function resolveLapF1Setup(lap: { carSetup?: string | null; telemetry?: TelemetryPacket[] }): F1CarSetup | null {
  if (lap.carSetup) {
    const parsed = safeParseF1Setup(lap.carSetup);
    if (parsed) return parsed;
  }
  return firstPacketF1Setup(lap.telemetry ?? []);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Canonical stable-key-order fingerprint of an F1CarSetup, excluding
 * `fuelLoad` (varies lap-to-lap by design) and rounding tyre pressures to
 * 1 decimal (telemetry noise). Two laps with the same fingerprint are
 * considered the same setup for import grouping/dedupe.
 */
export function f1SetupFingerprint(s: F1CarSetup): string {
  const canonical = {
    frontWing: s.frontWing,
    rearWing: s.rearWing,
    onThrottle: s.onThrottle,
    offThrottle: s.offThrottle,
    frontCamber: s.frontCamber,
    rearCamber: s.rearCamber,
    frontToe: s.frontToe,
    rearToe: s.rearToe,
    frontSuspension: s.frontSuspension,
    rearSuspension: s.rearSuspension,
    frontAntiRollBar: s.frontAntiRollBar,
    rearAntiRollBar: s.rearAntiRollBar,
    frontRideHeight: s.frontRideHeight,
    rearRideHeight: s.rearRideHeight,
    brakePressure: s.brakePressure,
    brakeBias: s.brakeBias,
    engineBraking: s.engineBraking,
    rearLeftTyrePressure: round1(s.rearLeftTyrePressure),
    rearRightTyrePressure: round1(s.rearRightTyrePressure),
    frontLeftTyrePressure: round1(s.frontLeftTyrePressure),
    frontRightTyrePressure: round1(s.frontRightTyrePressure),
  };
  return JSON.stringify(canonical);
}

/** Short one-line label for import-modal group headers. */
export function summarizeF1Setup(s: F1CarSetup): string {
  return `FW${s.frontWing}/RW${s.rearWing} · ARB ${s.frontAntiRollBar}/${s.rearAntiRollBar} · RH ${s.frontRideHeight}/${s.rearRideHeight} · Bias ${s.brakeBias}%`;
}
