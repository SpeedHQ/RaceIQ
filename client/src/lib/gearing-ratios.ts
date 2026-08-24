/**
 * Pure math for the gear-ratio chart of the user's setup (no React, no
 * telemetry). Speeds are derived from the setup itself: its stored top speed,
 * final drive and gear ratios, so editing the setup redraws the chart.
 */

/** Multiplier from m/s to the user's speed unit. */
export function speedUnitFactor(speedLabel: "km/h" | "mph"): number {
  return speedLabel === "mph" ? 2.23694 : 3.6;
}

/**
 * Tire circumference in metres implied by the setup's top speed: at redline in
 * the top gear the car reaches `topSpeedUser`. 0 when the inputs can't derive
 * one (missing top speed, non-positive ratios or final drive).
 */
export function tireCircumferenceM(topSpeedUser: number, topRatio: number, finalDrive: number, redlineRpm: number, userFactor: number): number {
  if (topSpeedUser <= 0 || topRatio <= 0 || finalDrive <= 0 || redlineRpm <= 0 || userFactor <= 0) return 0;
  return (topSpeedUser * topRatio * finalDrive) / (redlineRpm / 60) / userFactor;
}

/**
 * Speed in the user's unit at a given RPM, gear ratio and final drive:
 * V = rpm / 60 / (GR × FD) × circumference.
 */
export function setupSpeedAtRpm(circumferenceM: number, rpm: number, ratio: number, finalDrive: number, userFactor: number): number {
  if (circumferenceM <= 0 || ratio <= 0 || finalDrive <= 0) return 0;
  return (rpm / 60 / (ratio * finalDrive)) * circumferenceM * userFactor;
}

/** Fraction of peak power that marks "power dropped too much" — the shift point. */
export const SHIFT_DROP_RATIO = 0.99;

/**
 * Best shift RPM from the overall power curve: the first RPM past the peak
 * where power has fallen below SHIFT_DROP_RATIO of the peak. Null when the
 * curve is too short, peaks at the end, or power never drops that far (in
 * which case redline is the shift point).
 */
export function findBestShiftRpm(powerCurve: { rpm: number; powerW: number }[]): number | null {
  if (powerCurve.length < 2) return null;
  let peakIdx = 0;
  for (let i = 1; i < powerCurve.length; i++) {
    if (powerCurve[i].powerW > powerCurve[peakIdx].powerW) peakIdx = i;
  }
  if (peakIdx >= powerCurve.length - 1) return null;
  const threshold = powerCurve[peakIdx].powerW * SHIFT_DROP_RATIO;
  for (let i = peakIdx + 1; i < powerCurve.length; i++) {
    if (powerCurve[i].powerW <= threshold) return powerCurve[i].rpm;
  }
  // No drop below the ratio yet — if power is already declining, the best-known
  // shift point is the end of the recorded range (extends as pulls lengthen).
  return powerCurve[powerCurve.length - 1].powerW < powerCurve[peakIdx].powerW ? powerCurve[powerCurve.length - 1].rpm : null;
}

/** RPM where a curve peaks, or null when the curve is empty. */
export function findPeakRpm<T extends { rpm: number }>(curve: T[], valueKey: keyof T): number | null {
  let bestRpm: number | null = null;
  let bestValue = -Infinity;
  for (const point of curve) {
    const value = point[valueKey] as number;
    if (value > bestValue) {
      bestValue = value;
      bestRpm = point.rpm;
    }
  }
  return bestRpm;
}

/** Linearly interpolate a value from a sorted curve. */
export function interpolateValue<T extends { rpm: number }>(curve: T[], rpm: number, key: keyof T): number {
  if (curve.length === 0) return 0;
  if (rpm <= curve[0].rpm) return curve[0][key] as number;
  if (rpm >= curve[curve.length - 1].rpm) return curve[curve.length - 1][key] as number;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (rpm >= a.rpm && rpm <= b.rpm) {
      const t = (rpm - a.rpm) / (b.rpm - a.rpm);
      return (a[key] as number) + t * ((b[key] as number) - (a[key] as number));
    }
  }
  return 0;
}

/** Find the RPM where the visually-scaled power and torque lines cross. */
export function findVisualCrossing(powerCurve: { rpm: number; powerW: number }[], torqueCurve: { rpm: number; nm: number }[], maxPowerW: number, maxNm: number): number | null {
  if (powerCurve.length < 2 || torqueCurve.length < 2) return null;

  for (let i = 0; i < powerCurve.length - 1; i++) {
    const rpmA = powerCurve[i].rpm;
    const rpmB = powerCurve[i + 1].rpm;
    const powerA = powerCurve[i].powerW;
    const powerB = powerCurve[i + 1].powerW;

    const nmA = interpolateValue(torqueCurve, rpmA, "nm");
    const nmB = interpolateValue(torqueCurve, rpmB, "nm");

    const yPowerA = powerA / maxPowerW;
    const yPowerB = powerB / maxPowerW;
    const yNmA = nmA / maxNm;
    const yNmB = nmB / maxNm;

    const diffA = yPowerA - yNmA;
    const diffB = yPowerB - yNmB;

    if (diffA === 0) return rpmA;
    if (diffB === 0) return rpmB;
    if (diffA * diffB < 0) {
      // Linear interpolation between the two RPM points
      const t = Math.abs(diffA) / (Math.abs(diffA) + Math.abs(diffB));
      return rpmA + t * (rpmB - rpmA);
    }
  }
  return null;
}

/** Round a value up to the next multiple of step (nice axis bounds). */
export function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}
