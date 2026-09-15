import type { AlignedLapSet, AlignedLapTrace, EncodedAlignedLapSet, EncodedAlignedLapTrace, EncodedWheelTrace, WheelTrace } from "./types";

export function typedArrayToBase64(arr: ArrayBufferView): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
export function base64ToF32(value: string): Float32Array {
  const bytes = base64Bytes(value);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
export function base64ToU32(value: string): Uint32Array {
  const bytes = base64Bytes(value);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
export function base64ToU8(value: string): Uint8Array { return base64Bytes(value); }
function encodeWheel(value: WheelTrace<Float32Array> | null): EncodedWheelTrace | null {
  return value ? { FL: typedArrayToBase64(value.FL), FR: typedArrayToBase64(value.FR), RL: typedArrayToBase64(value.RL), RR: typedArrayToBase64(value.RR) } : null;
}
function decodeWheel(value: EncodedWheelTrace | null): WheelTrace<Float32Array> | null {
  return value ? { FL: base64ToF32(value.FL), FR: base64ToF32(value.FR), RL: base64ToF32(value.RL), RR: base64ToF32(value.RR) } : null;
}
const f = (v: Float32Array | null) => v ? typedArrayToBase64(v) : null;
const d = (v: string | null) => v == null ? null : base64ToF32(v);
export function encodeAlignedLapSet(set: AlignedLapSet): EncodedAlignedLapSet {
  return {
    distanceMeters: typedArrayToBase64(set.distanceMeters), distanceFractions: typedArrayToBase64(set.distanceFractions),
    nominalSpanMeters: set.nominalSpanMeters, distanceStartMeters: set.distanceStartMeters, distanceEndMeters: set.distanceEndMeters,
    stepMeters: set.stepMeters, referenceLapId: set.referenceLapId,
    laps: set.laps.map((t): EncodedAlignedLapTrace => ({
      lapId: t.lapId, lapNumber: t.lapNumber, lapTime: t.lapTime, isValid: t.isValid,
      sourceIndices: typedArrayToBase64(t.sourceIndices), speedMps: typedArrayToBase64(t.speedMps), throttle: typedArrayToBase64(t.throttle), brake: typedArrayToBase64(t.brake), steer: typedArrayToBase64(t.steer), rpm: typedArrayToBase64(t.rpm), gear: typedArrayToBase64(t.gear), positionX: typedArrayToBase64(t.positionX), positionZ: typedArrayToBase64(t.positionZ), yaw: typedArrayToBase64(t.yaw), elapsedTimeS: typedArrayToBase64(t.elapsedTimeS), fuel: typedArrayToBase64(t.fuel),
      tireWear: encodeWheel(t.tireWear), tireTemp: encodeWheel(t.tireTemp), tirePressure: encodeWheel(t.tirePressure), brakeTemp: encodeWheel(t.brakeTemp), suspTravel: encodeWheel(t.suspTravel), combinedSlip: encodeWheel(t.combinedSlip), balanceDeg: f(t.balanceDeg), latG: f(t.latG), longG: f(t.longG), tireAverages: t.tireAverages, pressureAverages: t.pressureAverages, brakeTempAverages: t.brakeTempAverages, sectorTimes: t.sectorTimes, sectorStarts: t.sectorStarts,
    })),
  };
}
export function decodeAlignedLapSet(e: EncodedAlignedLapSet): AlignedLapSet {
  const frac = base64ToF32(e.distanceFractions);
  return {
    distanceMeters: base64ToF32(e.distanceMeters), distanceFractions: frac, nominalSpanMeters: e.nominalSpanMeters, distanceStartMeters: e.distanceStartMeters, distanceEndMeters: e.distanceEndMeters, stepMeters: e.stepMeters, referenceLapId: e.referenceLapId,
    laps: e.laps.map((t): AlignedLapTrace => ({
      lapId: t.lapId, lapNumber: t.lapNumber, lapTime: t.lapTime, isValid: t.isValid, frac,
      sourceIndices: base64ToU32(t.sourceIndices), speedMps: base64ToF32(t.speedMps), throttle: base64ToF32(t.throttle), brake: base64ToF32(t.brake), steer: base64ToF32(t.steer), rpm: base64ToF32(t.rpm), gear: base64ToU8(t.gear), positionX: base64ToF32(t.positionX), positionZ: base64ToF32(t.positionZ), yaw: base64ToF32(t.yaw), elapsedTimeS: base64ToF32(t.elapsedTimeS), fuel: base64ToF32(t.fuel), tireWear: decodeWheel(t.tireWear), tireTemp: decodeWheel(t.tireTemp), tirePressure: decodeWheel(t.tirePressure), brakeTemp: decodeWheel(t.brakeTemp), suspTravel: decodeWheel(t.suspTravel), combinedSlip: decodeWheel(t.combinedSlip), balanceDeg: d(t.balanceDeg), latG: d(t.latG), longG: d(t.longG), tireAverages: t.tireAverages, pressureAverages: t.pressureAverages, brakeTempAverages: t.brakeTempAverages, sectorTimes: t.sectorTimes, sectorStarts: t.sectorStarts,
    })),
  };
}
