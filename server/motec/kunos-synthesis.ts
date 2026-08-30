import { findChannel, type LdChannel, type LdLog } from "./ld";

export const MOTEC_SYNTH_HZ = 60;
export const MOTEC_STEER_LOCK_DEG = 240;
const MIN_LAP_SECONDS = 30;
const G = 9.80665;
const MIN_SPEED_FOR_CURVATURE_MS = 3;

export const MOTEC_CHANNELS = {
  speed: ["SPEED", "GROUND_SPEED", "Ground Speed"],
  throttle: ["THROTTLE", "Throttle Pos", "THROTTLE_POS"],
  brake: ["BRAKE", "Brake Pos", "BRAKE_POS"],
  clutch: ["CLUTCH"],
  steer: ["STEERANGLE", "STEER_ANGLE", "Steering Angle"],
  rpm: ["RPMS", "RPM", "Engine RPM", "EN_RPM"],
  gear: ["GEAR"],
  gLat: ["G_LAT", "G Force Lat"],
  gLon: ["G_LON", "G Force Long"],
  yawRate: ["ROTY", "YAW_RATE"],
  fuel: ["FUEL_LEVEL", "FUEL", "EN_FUEL_LEVEL"],
  tc: ["TC"],
  abs: ["ABS"],
  brakeTemp: (c: string) => [`BRAKE_TEMP_${c}`],
  tyrePress: (c: string) => [`TYRE_PRESS_${c}`],
  tyreTemp: (c: string) => [`TYRE_TAIR_${c}`, `TYRE_TEMP_${c}`],
  suspTravel: (c: string) => [`SUS_TRAVEL_${c}`],
  wheelSpeed: (c: string) => [`WHEEL_SPEED_${c}`],
} as const;

export const MOTEC_CORNERS = ["LF", "RF", "LR", "RR"] as const;

export const MOTEC_IMPORT_LIMITATIONS = [
  "Racing line is drawn from an estimated path: speed is integrated using logged yaw rate, with lateral G force as the fallback when yaw is unavailable. It can drift, so use it to compare lap shape — not exact track position.",
  "Steering is normalised against an assumed 240° lock — MoTeC does not export the car's steering lock.",
  "Suspension and wheel-speed channels are logged by MoTeC at 200 Hz and are resampled down to 60 Hz.",
  "Sector times are recomputed from track geometry, not read from the log.",
] as const;

export interface DeadReckonedPath {
  x: Float64Array; z: Float64Array; vx: Float64Array; vz: Float64Array;
  heading: Float64Array;
  yawFromLateralG: boolean;
}

export interface PreparedKunosMotecCapture {
  frameCount: number; dt: number; windows: Array<[number, number]>; lapIndexOf: Int32Array;
  sessionDistanceM: Float64Array; lapDistanceM: Float64Array; lapLengthM: number;
  path: DeadReckonedPath; speedKmh: Float64Array; throttle: Float64Array; brake: Float64Array;
  clutch: Float64Array; steerDegrees: Float64Array; rpm: Float64Array; gear: Float64Array;
  lateralG: Float64Array; longitudinalG: Float64Array; yawRate: Float64Array; fuel: Float64Array;
  tc: Float64Array; abs: Float64Array; brakeTemperature: Float64Array[];
  tyrePressure: Float64Array[]; tyreTemperature: Float64Array[]; suspensionTravel: Float64Array[];
  suspensionTravelUnits: string; wheelSpeed: Float64Array[]; missingChannels: string[];
}

function peakAbs(values: Float64Array): number {
  let peak = 0;
  for (const value of values) peak = Math.max(peak, Math.abs(value));
  return peak;
}
function pick(log: LdLog, names: readonly string[]): LdChannel | undefined {
  for (const name of names) { const channel = findChannel(log, name); if (channel) return channel; }
  return undefined;
}
function resample(channel: LdChannel | undefined, frames: number, dt: number): Float64Array {
  const out = new Float64Array(frames);
  if (!channel || channel.samples.length === 0 || channel.effectiveFreq <= 0) return out;
  const last = channel.samples.length - 1;
  for (let i = 0; i < frames; i++) {
    const index = Math.round(i * dt * channel.effectiveFreq);
    out[i] = channel.samples[Math.max(0, Math.min(last, index))] ?? 0;
  }
  return out;
}
function normalizePedal(values: Float64Array): Float64Array {
  const scale = peakAbs(values) > 1.5 ? 0.01 : 1;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Math.max(0, Math.min(1, values[i]! * scale));
  return out;
}
function speedToKmh(values: Float64Array, channel: LdChannel | undefined): Float64Array {
  const unit = (channel?.unit ?? "").toLowerCase();
  const factor = unit.includes("m/s") || unit === "ms" ? 3.6 : unit.includes("mph") ? 1.609344 : 1;
  if (factor === 1) return values;
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = values[i]! * factor;
  return out;
}

export function deadReckonPath(speedKmh: Float64Array, yawRate: Float64Array, gLat: Float64Array, lapIndexOf: Int32Array, dt: number, yawUnit: string): DeadReckonedPath {
  const frames = speedKmh.length;
  const x = new Float64Array(frames), z = new Float64Array(frames), vx = new Float64Array(frames), vz = new Float64Array(frames), headingOut = new Float64Array(frames);
  const hasYaw = peakAbs(yawRate) > 0;
  const yawToRad = /deg|°/i.test(yawUnit) ? Math.PI / 180 : 1;
  let heading = 0, px = 0, pz = 0;
  for (let i = 0; i < frames; i++) {
    const lapStart = i === 0 || lapIndexOf[i] !== lapIndexOf[i - 1];
    if (lapStart) { heading = 0; px = 0; pz = 0; }
    const speed = speedKmh[i]! / 3.6;
    const omega = hasYaw ? yawRate[i]! * yawToRad : speed > MIN_SPEED_FOR_CURVATURE_MS ? gLat[i]! * G / speed : 0;
    if (!lapStart) heading += omega * dt;
    const cx = Math.sin(heading) * speed, cz = Math.cos(heading) * speed;
    if (!lapStart) { px += cx * dt; pz += cz * dt; }
    vx[i] = cx; vz[i] = cz; x[i] = px; z[i] = pz; headingOut[i] = heading;
  }
  closeLapLoops(x, z, lapIndexOf);
  return { x, z, vx, vz, heading: headingOut, yawFromLateralG: !hasYaw };
}
function closeLapLoops(x: Float64Array, z: Float64Array, lapIndexOf: Int32Array): void {
  if (x.length === 0) return;
  const lastLap = lapIndexOf[x.length - 1]!;
  let start = 0;
  for (let i = 1; i <= x.length; i++) {
    if (i < x.length && lapIndexOf[i] === lapIndexOf[start]) continue;
    const end = i - 1, span = end - start;
    if (lapIndexOf[start]! !== lastLap && span > 0) {
      const errX = x[end]! - x[start]!, errZ = z[end]! - z[start]!;
      for (let j = start; j <= end; j++) { const t = (j - start) / span; x[j] -= errX * t; z[j] -= errZ * t; }
    }
    start = i;
  }
}

export function lapWindows(beacons: number[], duration: number): Array<[number, number]> {
  const splits = beacons.filter((time) => time > 0 && time < duration).sort((a, b) => a - b);
  const bounds = [0, ...splits, duration];
  const windows: Array<[number, number]> = [];
  let start = bounds[0]!;
  for (let i = 1; i < bounds.length; i++) {
    const end = bounds[i]!;
    if (end - start < MIN_LAP_SECONDS && i < bounds.length - 1) continue;
    windows.push([start, end]); start = end;
  }
  if (windows.length === 0) windows.push([0, duration]);
  return windows;
}

export function prepareKunosMotecCapture(log: LdLog, beacons: number[], profile: { gameId: "acc" | "ac-evo"; trackOrdinal: number } = { gameId: "acc", trackOrdinal: -1 }): PreparedKunosMotecCapture {
  const dt = 1 / MOTEC_SYNTH_HZ;
  if (!(log.duration > 0)) throw new Error("MoTeC log has no usable duration");
  const frameCount = Math.max(1, Math.floor(log.duration * MOTEC_SYNTH_HZ));
  const missingChannels: string[] = [];
  const take = (names: readonly string[]) => { const channel = pick(log, names); if (!channel) missingChannels.push(names[0]!); return channel; };
  const speedCh = take(MOTEC_CHANNELS.speed);
  const speedKmh = speedToKmh(resample(speedCh, frameCount, dt), speedCh);
  const throttle = normalizePedal(resample(take(MOTEC_CHANNELS.throttle), frameCount, dt));
  const brake = normalizePedal(resample(take(MOTEC_CHANNELS.brake), frameCount, dt));
  const clutch = normalizePedal(resample(pick(log, MOTEC_CHANNELS.clutch), frameCount, dt));
  const steerDegrees = resample(take(MOTEC_CHANNELS.steer), frameCount, dt);
  const rpm = resample(take(MOTEC_CHANNELS.rpm), frameCount, dt);
  const gear = resample(take(MOTEC_CHANNELS.gear), frameCount, dt);
  const lateralG = resample(take(MOTEC_CHANNELS.gLat), frameCount, dt);
  const longitudinalG = resample(take(MOTEC_CHANNELS.gLon), frameCount, dt);
  const yawCh = pick(log, MOTEC_CHANNELS.yawRate), yawRate = resample(yawCh, frameCount, dt);
  const tc = resample(pick(log, MOTEC_CHANNELS.tc), frameCount, dt);
  const abs = resample(pick(log, MOTEC_CHANNELS.abs), frameCount, dt);
  const fuel = resample(pick(log, MOTEC_CHANNELS.fuel), frameCount, dt);
  const brakeTemperature = MOTEC_CORNERS.map((c) => resample(pick(log, MOTEC_CHANNELS.brakeTemp(c)), frameCount, dt));
  const tyrePressure = MOTEC_CORNERS.map((c) => resample(pick(log, MOTEC_CHANNELS.tyrePress(c)), frameCount, dt));
  const tyreTemperature = MOTEC_CORNERS.map((c) => resample(pick(log, MOTEC_CHANNELS.tyreTemp(c)), frameCount, dt));
  const suspensionTravel = MOTEC_CORNERS.map((c) => {
    const values = resample(pick(log, MOTEC_CHANNELS.suspTravel(c)), frameCount, dt);
    const unit = findChannel(log, `SUS_TRAVEL_${c}`)?.unit ?? "";
    if (/^(mm|millimet(er|re)s?)$/i.test(unit.trim())) for (let i = 0; i < values.length; i++) values[i] /= 1000;
    if (profile.gameId === "ac-evo") {
      let mean = 0; for (const value of values) mean += value; mean /= Math.max(1, values.length);
      for (let i = 0; i < values.length; i++) values[i] -= mean;
    }
    return values;
  });
  const wheelSpeed = MOTEC_CORNERS.map((c) => resample(pick(log, MOTEC_CHANNELS.wheelSpeed(c)), frameCount, dt));
  const windows = lapWindows(beacons, log.duration), lapIndexOf = new Int32Array(frameCount);
  const sessionDistanceM = new Float64Array(frameCount), lapDistanceM = new Float64Array(frameCount);
  let lap = 0, session = 0, lapStartDist = 0;

  for (let i = 0; i < frameCount; i++) {
    while (lap < windows.length - 1 && i * dt >= windows[lap]![1]) { lap++; lapStartDist = session; }
    if (i > 0) session += speedKmh[i]! / 3.6 * dt;
    lapIndexOf[i] = lap; sessionDistanceM[i] = session; lapDistanceM[i] = session - lapStartDist;
  }
  let lapLengthM = 0;
  for (let i = 0; i < frameCount; i++) if ((i + 1 >= frameCount || lapIndexOf[i + 1] !== lapIndexOf[i]) && lapIndexOf[i]! < windows.length - 1) lapLengthM = Math.max(lapLengthM, lapDistanceM[i]!);
  if (lapLengthM === 0) lapLengthM = lapDistanceM[frameCount - 1] ?? 0;
  return { frameCount, dt, windows, lapIndexOf, sessionDistanceM, lapDistanceM, lapLengthM, path: deadReckonPath(speedKmh, yawRate, lateralG, lapIndexOf, dt, yawCh?.unit ?? ""), speedKmh, throttle, brake, clutch, steerDegrees, rpm, gear, lateralG, longitudinalG, yawRate, fuel, tc, abs, brakeTemperature, tyrePressure, tyreTemperature, suspensionTravel, suspensionTravelUnits: findChannel(log, "SUS_TRAVEL_LF")?.unit ?? "", wheelSpeed, missingChannels };
}

/** Integrate ROTY into a heading trace before packet resampling. */
export function reconstructYawHeading(channel: LdChannel, frames: number, dt: number, _windows: ReadonlyArray<readonly [number, number]>, _closedLapMask: Uint8Array): Float64Array {
  const out = new Float64Array(frames);
  const scale = /deg|°/i.test(channel.unit) ? Math.PI / 180 : 1;
  for (let i = 1; i < frames; i++) out[i] = out[i - 1]! + (channel.samples[Math.min(channel.samples.length - 1, Math.round(i * dt * channel.effectiveFreq))] ?? 0) * scale * dt;
  return out;
}
