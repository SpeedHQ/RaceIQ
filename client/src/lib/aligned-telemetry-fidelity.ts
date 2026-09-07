import type { AlignedLapSet, AlignedLapTrace, WheelTrace } from "@shared/racing/laps/alignment/types";

export const HIGH_FIDELITY_STEP = 0.1 as const;
export function shouldLoadHighFidelity(selectedSpan: number, currentSpan: number): boolean {
  return selectedSpan > 0 && currentSpan > 0 && selectedSpan < currentSpan * 0.98;
}
export function normalizeFidelityRange(start: number, end: number, domain: number, minPadding = 2) {
  const low = Math.max(0, Math.min(domain, Math.min(start, end)));
  const high = Math.max(low, Math.min(domain, Math.max(start, end)));
  const padding = Math.max(minPadding, (high - low) * 0.1);
  return { start: Math.max(0, low - padding), end: Math.min(domain, high + padding), step: HIGH_FIDELITY_STEP } as const;
}
function sliceF32(v: Float32Array, first: number, last: number): Float32Array { return v.slice(first, last + 1); }
function sliceU32(v: Uint32Array, first: number, last: number): Uint32Array { return v.slice(first, last + 1); }
function sliceU8(v: Uint8Array, first: number, last: number): Uint8Array { return v.slice(first, last + 1); }
function cropTrace(t: AlignedLapTrace, first: number, last: number): AlignedLapTrace {
  const cropWheel = (v: WheelTrace<Float32Array> | null) => v ? { FL: sliceF32(v.FL, first, last), FR: sliceF32(v.FR, first, last), RL: sliceF32(v.RL, first, last), RR: sliceF32(v.RR, first, last) } : null;
  return {
    ...t, frac: sliceF32(t.frac, first, last), sourceIndices: sliceU32(t.sourceIndices, first, last),
    speedMps: sliceF32(t.speedMps, first, last), throttle: sliceF32(t.throttle, first, last), brake: sliceF32(t.brake, first, last), steer: sliceF32(t.steer, first, last), rpm: sliceF32(t.rpm, first, last), gear: sliceU8(t.gear, first, last), positionX: sliceF32(t.positionX, first, last), positionZ: sliceF32(t.positionZ, first, last), yaw: sliceF32(t.yaw, first, last), elapsedTimeS: sliceF32(t.elapsedTimeS, first, last), fuel: sliceF32(t.fuel, first, last), tireWear: cropWheel(t.tireWear),
    tireTemp: cropWheel(t.tireTemp), tirePressure: cropWheel(t.tirePressure), brakeTemp: cropWheel(t.brakeTemp), suspTravel: cropWheel(t.suspTravel), combinedSlip: cropWheel(t.combinedSlip),
    balanceDeg: t.balanceDeg ? sliceF32(t.balanceDeg, first, last) : null, latG: t.latG ? sliceF32(t.latG, first, last) : null, longG: t.longG ? sliceF32(t.longG, first, last) : null,
  };
}
export function cropAlignedLapSet(set: AlignedLapSet, start: number, end: number): AlignedLapSet {
  const low = Math.min(start, end), high = Math.max(start, end);
  let first = 0; while (first < set.distanceMeters.length - 1 && set.distanceMeters[first] < low) first++;
  let last = set.distanceMeters.length - 1; while (last > first && set.distanceMeters[last] > high) last--;
  return { ...set, distanceMeters: sliceF32(set.distanceMeters, first, last), distanceFractions: sliceF32(set.distanceFractions, first, last), distanceStartMeters: set.distanceMeters[first] ?? set.distanceStartMeters, distanceEndMeters: set.distanceMeters[last] ?? set.distanceEndMeters, laps: set.laps.map((lap) => cropTrace(lap, first, last)) };
}
export function rangeAlignedLapSet(_base: AlignedLapSet, range: AlignedLapSet): AlignedLapSet { return range; }
export function mergeAlignedLapRange(base: AlignedLapSet, detail: AlignedLapSet): AlignedLapSet {
  return detail.distanceMeters.length ? { ...base, ...detail, laps: detail.laps } : base;
}
