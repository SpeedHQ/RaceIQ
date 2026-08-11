import type { EncodedLapTrace, EncodedTireTraces, LapTrace, TireTraces } from "./types";

/** Float32Array → base64 of its raw little-endian bytes. Copies the exact
 *  [byteOffset, byteLength) window so a subarray view doesn't leak siblings. */
export function f32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let bin = "";
  const CHUNK = 0x8000; // avoid String.fromCharCode arg-count limits
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64 → Float32Array. Byte length is always a multiple of 4 (Float32). */
export function base64ToF32(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength >>> 2);
}

function encodeTireTraces(t: TireTraces | null): EncodedTireTraces | null {
  if (!t) return null;
  return { FL: f32ToBase64(t.FL), FR: f32ToBase64(t.FR), RL: f32ToBase64(t.RL), RR: f32ToBase64(t.RR) };
}

function decodeTireTraces(t: EncodedTireTraces | null): TireTraces | null {
  if (!t) return null;
  return { FL: base64ToF32(t.FL), FR: base64ToF32(t.FR), RL: base64ToF32(t.RL), RR: base64ToF32(t.RR) };
}

export function encodeLapTrace(t: LapTrace): EncodedLapTrace {
  return {
    lapId: t.lapId,
    lapNumber: t.lapNumber,
    isValid: t.isValid,
    n: t.n,
    frac: f32ToBase64(t.frac),
    throttle: f32ToBase64(t.throttle),
    brake: f32ToBase64(t.brake),
    steer: f32ToBase64(t.steer),
    speedKmh: f32ToBase64(t.speedKmh),
    timeS: f32ToBase64(t.timeS),
    tire: t.tire,
    pressure: t.pressure,
    tireTempTrace: encodeTireTraces(t.tireTempTrace),
    pressureTrace: encodeTireTraces(t.pressureTrace),
    balance: t.balance ? f32ToBase64(t.balance) : null,
    latG: t.latG ? f32ToBase64(t.latG) : null,
    longG: t.longG ? f32ToBase64(t.longG) : null,
    suspTravel: encodeTireTraces(t.suspTravel),
    combinedSlip: encodeTireTraces(t.combinedSlip),
    brakeTemp: t.brakeTemp,
    brakeTempTrace: encodeTireTraces(t.brakeTempTrace),
  };
}

export function decodeLapTrace(e: EncodedLapTrace): LapTrace {
  return {
    lapId: e.lapId,
    lapNumber: e.lapNumber,
    isValid: e.isValid,
    n: e.n,
    frac: base64ToF32(e.frac),
    throttle: base64ToF32(e.throttle),
    brake: base64ToF32(e.brake),
    steer: base64ToF32(e.steer),
    speedKmh: base64ToF32(e.speedKmh),
    timeS: base64ToF32(e.timeS),
    tire: e.tire,
    pressure: e.pressure,
    tireTempTrace: decodeTireTraces(e.tireTempTrace),
    pressureTrace: decodeTireTraces(e.pressureTrace),
    balance: e.balance ? base64ToF32(e.balance) : null,
    latG: e.latG ? base64ToF32(e.latG) : null,
    longG: e.longG ? base64ToF32(e.longG) : null,
    suspTravel: decodeTireTraces(e.suspTravel),
    combinedSlip: decodeTireTraces(e.combinedSlip),
    brakeTemp: e.brakeTemp,
    brakeTempTrace: decodeTireTraces(e.brakeTempTrace),
  };
}
