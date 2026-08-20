import type { GameId } from "@shared/games/ids";
import type { TelemetryPacket } from "@shared/telemetry/types";
import { type GearBucket, type GearingSample, MAX_TRACK_SAMPLES, sessionKeyFor, type TrackSpeedLap } from "./gearing-telemetry";
import { isSampleValid } from "./gearing-validation";

const BUCKET_SIZE = 100;

export interface SessionGearingState {
  buckets: Record<number, Record<number, GearBucket>>;
  powerCurves: Record<number, { rpm: number; hp: number }[]>;
  powerCurve: { rpm: number; hp: number }[];
  torqueCurve: { rpm: number; nm: number }[];
  shiftPoints: Record<number, number>;
}

/**
 * Pure per-lap track-speed traces for a packet slice (replay/history view).
 * Mirrors the live `trackTrackSpeedSample` accumulator: lap or session
 * boundaries demote the current lap to `previous` and start a fresh trace.
 */
export function computeTrackLaps(packets: GearingSample[]): { current: TrackSpeedLap | null; previous: TrackSpeedLap | null } {
  let sessionKey: string | null = null;
  let laps: { current: TrackSpeedLap | null; previous: TrackSpeedLap | null } = { current: null, previous: null };
  let lapStartDistance = 0;
  for (const packet of packets) {
    if (!isSampleValid(packet)) continue;
    const key = sessionKeyFor(packet);
    const current = laps.current;
    if (key !== sessionKey || !current) {
      sessionKey = key;
      laps = { current: { lapNumber: packet.LapNumber, samples: [] }, previous: null };
      lapStartDistance = packet.DistanceTraveled;
    } else if (packet.LapNumber !== current.lapNumber) {
      laps = {
        previous: current.samples.length > 0 ? current : laps.previous,
        current: { lapNumber: packet.LapNumber, samples: [] },
      };
      lapStartDistance = packet.DistanceTraveled;
    }
    const distance = Math.max(0, packet.DistanceTraveled - lapStartDistance);
    let samples = [...laps.current!.samples, { distance, speed: packet.DisplaySpeed, gear: packet.Gear }];
    if (samples.length > MAX_TRACK_SAMPLES) {
      samples = samples.slice(samples.length - MAX_TRACK_SAMPLES);
    }
    laps = { ...laps, current: { lapNumber: laps.current!.lapNumber, samples } };
  }
  return laps;
}

function isSampleValidRaw(packet: TelemetryPacket, gameId: GameId): boolean {
  switch (gameId) {
    case "fm-2023":
      return packet.IsRaceOn > 0 && packet.Gear !== 11 && packet.Gear > 0;
    default:
      return true;
  }
}

function getDisplayPower(packet: TelemetryPacket, gameId: GameId): number {
  if (gameId === "fm-2023") return packet.Power / 745.7;
  if (gameId === "f1-2025") return packet.Power;
  return 0;
}

function getDisplayTorque(packet: TelemetryPacket, gameId: GameId): number {
  if (gameId === "fm-2023") return packet.Torque;
  return 0;
}

/** Stride for downsampling — process every Nth packet to reduce CPU load. */
const DEFAULT_STRIDE = 5;

export function accumulateBuckets(buckets: Record<number, Record<number, GearBucket>>, packets: TelemetryPacket[], gameId: GameId, stride = DEFAULT_STRIDE): void {
  for (let i = 0; i < packets.length; i += stride) {
    const packet = packets[i];
    if (!isSampleValidRaw(packet, gameId)) continue;

    const gear = packet.Gear;
    const rpm = packet.CurrentEngineRpm;
    const bucketIdx = Math.floor(rpm / BUCKET_SIZE);
    const hp = getDisplayPower(packet, gameId);
    const nm = getDisplayTorque(packet, gameId);

    if (!buckets[gear]) buckets[gear] = {};
    if (!buckets[gear][bucketIdx]) {
      buckets[gear][bucketIdx] = {
        rpmMin: bucketIdx * BUCKET_SIZE,
        hpSum: 0,
        hpCount: 0,
        nmSum: 0,
        nmCount: 0,
      };
    }

    if (hp > 0) {
      buckets[gear][bucketIdx].hpSum += hp;
      buckets[gear][bucketIdx].hpCount += 1;
    }
    if (nm > 0) {
      buckets[gear][bucketIdx].nmSum += nm;
      buckets[gear][bucketIdx].nmCount += 1;
    }
  }
}

export function buildStateFromBuckets(buckets: Record<number, Record<number, GearBucket>>): SessionGearingState {
  // Per-gear power curves
  const powerCurves: Record<number, { rpm: number; hp: number }[]> = {};
  const gears = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b);
  for (const g of gears) {
    powerCurves[g] = Object.values(buckets[g])
      .filter((b) => b.hpCount > 0)
      .sort((a, b) => a.rpmMin - b.rpmMin)
      .map((b) => ({ rpm: b.rpmMin + BUCKET_SIZE / 2, hp: b.hpSum / b.hpCount }));
  }

  // Optimal shift points
  const shiftPoints: Record<number, number> = {};
  for (let i = 0; i < gears.length - 1; i++) {
    const currentGear = gears[i];
    const nextGear = gears[i + 1];
    const currentCurve = powerCurves[currentGear];
    const nextCurve = powerCurves[nextGear];

    if (!currentCurve || currentCurve.length < 2 || !nextCurve || nextCurve.length < 2) continue;

    let bestShiftRpm = 0;
    let smallestDiff = Infinity;

    for (const cp of currentCurve) {
      const rpmInNextGear = cp.rpm * (nextCurve[0].rpm / currentCurve[0].rpm);
      const interpolatedHp = interpolateHp(nextCurve, rpmInNextGear);
      const diff = Math.abs(cp.hp - interpolatedHp);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        bestShiftRpm = cp.rpm;
      }
    }

    if (bestShiftRpm > 0) {
      shiftPoints[currentGear] = bestShiftRpm;
    }
  }

  // Aggregate overall power/torque curves
  const hpByRpm = new Map<number, { sum: number; count: number }>();
  const nmByRpm = new Map<number, { sum: number; count: number }>();

  for (const gearBuckets of Object.values(buckets)) {
    for (const bucket of Object.values(gearBuckets)) {
      const rpm = bucket.rpmMin + 50;
      if (bucket.hpCount > 0) {
        const existing = hpByRpm.get(rpm) ?? { sum: 0, count: 0 };
        existing.sum += bucket.hpSum;
        existing.count += bucket.hpCount;
        hpByRpm.set(rpm, existing);
      }
      if (bucket.nmCount > 0) {
        const existing = nmByRpm.get(rpm) ?? { sum: 0, count: 0 };
        existing.sum += bucket.nmSum;
        existing.count += bucket.nmCount;
        nmByRpm.set(rpm, existing);
      }
    }
  }

  const rawPowerCurve = Array.from(hpByRpm.entries())
    .map(([rpm, { sum, count }]) => ({ rpm, hp: sum / count }))
    .sort((a, b) => a.rpm - b.rpm);

  const rawTorqueCurve = Array.from(nmByRpm.entries())
    .map(([rpm, { sum, count }]) => ({ rpm, nm: sum / count }))
    .sort((a, b) => a.rpm - b.rpm);

  return {
    buckets,
    powerCurves,
    powerCurve: smoothCurve(rawPowerCurve, "hp", 5),
    torqueCurve: smoothCurve(rawTorqueCurve, "nm", 5),
    shiftPoints,
  };
}

/**
 * Compute session-aggregated gearing state from raw telemetry packets.
 * Avoids DisplayPacket creation — much faster for large session datasets.
 */
export function computeGearingStateRaw(packets: TelemetryPacket[], gameId: GameId): SessionGearingState {
  const buckets: Record<number, Record<number, GearBucket>> = {};
  accumulateBuckets(buckets, packets, gameId);
  return buildStateFromBuckets(buckets);
}

/**
 * Compute session-aggregated gearing state from an array of display packets.
 * This is a pure function — it does not touch the live telemetry singleton.
 */
export function computeGearingState(packets: GearingSample[]): SessionGearingState {
  const buckets: Record<number, Record<number, GearBucket>> = {};

  for (const packet of packets) {
    if (!isSampleValid(packet)) continue;

    const gear = packet.Gear;
    const rpm = packet.CurrentEngineRpm;
    const bucketIdx = Math.floor(rpm / BUCKET_SIZE);
    const hp = packet.DisplayPower;
    const nm = packet.DisplayTorque;

    if (!buckets[gear]) buckets[gear] = {};
    if (!buckets[gear][bucketIdx]) {
      buckets[gear][bucketIdx] = {
        rpmMin: bucketIdx * BUCKET_SIZE,
        hpSum: 0,
        hpCount: 0,
        nmSum: 0,
        nmCount: 0,
      };
    }

    if (hp > 0) {
      buckets[gear][bucketIdx].hpSum += hp;
      buckets[gear][bucketIdx].hpCount += 1;
    }
    if (nm > 0) {
      buckets[gear][bucketIdx].nmSum += nm;
      buckets[gear][bucketIdx].nmCount += 1;
    }
  }

  // Per-gear power curves
  const powerCurves: Record<number, { rpm: number; hp: number }[]> = {};
  const gears = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b);
  for (const g of gears) {
    powerCurves[g] = Object.values(buckets[g])
      .filter((b) => b.hpCount > 0)
      .sort((a, b) => a.rpmMin - b.rpmMin)
      .map((b) => ({ rpm: b.rpmMin + BUCKET_SIZE / 2, hp: b.hpSum / b.hpCount }));
  }

  // Optimal shift points
  const shiftPoints: Record<number, number> = {};
  for (let i = 0; i < gears.length - 1; i++) {
    const currentGear = gears[i];
    const nextGear = gears[i + 1];
    const currentCurve = powerCurves[currentGear];
    const nextCurve = powerCurves[nextGear];

    if (!currentCurve || currentCurve.length < 2 || !nextCurve || nextCurve.length < 2) continue;

    let bestShiftRpm = 0;
    let smallestDiff = Infinity;

    for (const cp of currentCurve) {
      const rpmInNextGear = cp.rpm * (nextCurve[0].rpm / currentCurve[0].rpm);
      const interpolatedHp = interpolateHp(nextCurve, rpmInNextGear);
      const diff = Math.abs(cp.hp - interpolatedHp);
      if (diff < smallestDiff) {
        smallestDiff = diff;
        bestShiftRpm = cp.rpm;
      }
    }

    if (bestShiftRpm > 0) {
      shiftPoints[currentGear] = bestShiftRpm;
    }
  }

  // Aggregate overall power/torque curves
  const hpByRpm = new Map<number, { sum: number; count: number }>();
  const nmByRpm = new Map<number, { sum: number; count: number }>();

  for (const gearBuckets of Object.values(buckets)) {
    for (const bucket of Object.values(gearBuckets)) {
      const rpm = bucket.rpmMin + 50;
      if (bucket.hpCount > 0) {
        const existing = hpByRpm.get(rpm) ?? { sum: 0, count: 0 };
        existing.sum += bucket.hpSum;
        existing.count += bucket.hpCount;
        hpByRpm.set(rpm, existing);
      }
      if (bucket.nmCount > 0) {
        const existing = nmByRpm.get(rpm) ?? { sum: 0, count: 0 };
        existing.sum += bucket.nmSum;
        existing.count += bucket.nmCount;
        nmByRpm.set(rpm, existing);
      }
    }
  }

  const rawPowerCurve = Array.from(hpByRpm.entries())
    .map(([rpm, { sum, count }]) => ({ rpm, hp: sum / count }))
    .sort((a, b) => a.rpm - b.rpm);

  const rawTorqueCurve = Array.from(nmByRpm.entries())
    .map(([rpm, { sum, count }]) => ({ rpm, nm: sum / count }))
    .sort((a, b) => a.rpm - b.rpm);

  return {
    buckets,
    powerCurves,
    powerCurve: smoothCurve(rawPowerCurve, "hp", 5),
    torqueCurve: smoothCurve(rawTorqueCurve, "nm", 5),
    shiftPoints,
  };
}

function interpolateHp(curve: { rpm: number; hp: number }[], rpm: number): number {
  if (curve.length === 0) return 0;
  if (rpm <= curve[0].rpm) return curve[0].hp;
  if (rpm >= curve[curve.length - 1].rpm) return curve[curve.length - 1].hp;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (rpm >= a.rpm && rpm <= b.rpm) {
      const t = (rpm - a.rpm) / (b.rpm - a.rpm);
      return a.hp + t * (b.hp - a.hp);
    }
  }
  return 0;
}

function smoothCurve<T extends { rpm: number }>(curve: T[], valueKey: keyof T, windowSize: number): T[] {
  if (curve.length < 3) return curve;
  const half = Math.floor(windowSize / 2);
  return curve.map((point, i) => {
    let sum = 0;
    let count = 0;
    for (let j = -half; j <= half; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < curve.length) {
        sum += curve[idx][valueKey] as number;
        count++;
      }
    }
    return { ...point, [valueKey]: sum / count } as T;
  });
}
