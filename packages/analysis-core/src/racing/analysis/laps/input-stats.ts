export interface SteerScale {
  center: number;
  range: number;
}

export interface InputStats {
  throttleAvg: number;
  throttleMax: number;
  fullThrottlePctDist: number;
  brakeAvg: number;
  brakeMax: number;
  brakingPctDist: number;
  brakeApplications: number;
  steerAbsAvg: number;
  steerAbsMax: number;
  steeringSmoothness: number;
  brakeOnDist: number | null;
  brakeOffDist: number | null;
  peakBrakeValue: number;
  peakBrakeDist: number | null;
  fullThrottleDist: number | null;
  liftOffThrottleDist: number | null;
  minSpeed: number;
  minSpeedDist: number | null;
  maxSpeed: number;
  maxSpeedDist: number | null;
}

const MPH_TO_KMH = 1.609344;

/** Aggregate + event statistics over [startIdx, endIdx) of aligned channels. */
export function computeStatsRange(
  throttle: number[], brake: number[], steer: number[], speedMph: number[], distances: number[],
  startIdx: number, endIdx: number, steerScale: SteerScale,
): InputStats {
  const lo = Math.max(0, Math.min(startIdx, throttle.length - 1));
  const hi = Math.max(lo + 1, Math.min(endIdx, throttle.length));
  const n = hi - lo;
  let tSum = 0, tMax = 0, tFull = 0;
  let bSum = 0, bMax = 0, bOn = 0, bEvents = 0, prevBrake = false;
  let sAbsSum = 0, sAbsMax = 0, smoothSum = 0, prev = 0;
  let brakeOnDist: number | null = null, brakeOffDist: number | null = null;
  let peakBrakeValue = 0, peakBrakeDist: number | null = null;
  let fullThrottleDist: number | null = null, liftOffThrottleDist: number | null = null;
  let sawFullThrottle = false;
  let minSpeed = Infinity, minSpeedDist: number | null = null;
  let maxSpeed = -Infinity, maxSpeedDist: number | null = null;

  for (let i = lo; i < hi; i++) {
    const t = throttle[i];
    tSum += t;
    if (t > tMax) tMax = t;
    if (t >= 0.95) {
      tFull++;
      if (fullThrottleDist == null) fullThrottleDist = distances[i];
      sawFullThrottle = true;
    } else if (sawFullThrottle && t < 0.8 && liftOffThrottleDist == null) liftOffThrottleDist = distances[i];

    const b = brake[i];
    bSum += b;
    if (b > bMax) bMax = b;
    if (b > peakBrakeValue) { peakBrakeValue = b; peakBrakeDist = distances[i]; }
    const isBraking = b > 0.05;
    if (isBraking) { bOn++; if (brakeOnDist == null) brakeOnDist = distances[i]; brakeOffDist = distances[i]; }
    if (isBraking && !prevBrake) bEvents++;
    prevBrake = isBraking;

    const norm = (steer[i] - steerScale.center) / (steerScale.range || 1);
    const a = Math.abs(norm);
    sAbsSum += a;
    if (a > sAbsMax) sAbsMax = a;
    if (i > lo) smoothSum += Math.abs(norm - prev);
    prev = norm;

    const speedKmh = speedMph[i] * MPH_TO_KMH;
    if (speedKmh < minSpeed) { minSpeed = speedKmh; minSpeedDist = distances[i]; }
    if (speedKmh > maxSpeed) { maxSpeed = speedKmh; maxSpeedDist = distances[i]; }
  }

  return {
    throttleAvg: tSum / n, throttleMax: tMax, fullThrottlePctDist: tFull / n,
    brakeAvg: bSum / n, brakeMax: bMax, brakingPctDist: bOn / n, brakeApplications: bEvents,
    steerAbsAvg: sAbsSum / n, steerAbsMax: sAbsMax, steeringSmoothness: n > 1 ? smoothSum / (n - 1) : 0,
    brakeOnDist, brakeOffDist, peakBrakeValue, peakBrakeDist, fullThrottleDist, liftOffThrottleDist,
    minSpeed: Number.isFinite(minSpeed) ? minSpeed : 0, minSpeedDist,
    maxSpeed: Number.isFinite(maxSpeed) ? maxSpeed : 0, maxSpeedDist,
  };
}
