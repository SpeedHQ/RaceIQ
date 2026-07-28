/**
 * Plain-language readings for the driving-style axes.
 *
 * Shared because two very different consumers must agree on what a given number
 * means: the coach prompt (`server/ai/driver-profiler-prompt.ts`) renders these so
 * the model cannot invent its own scale for "0.72", and the profile panel
 * (`client/src/components/driver/StyleGauges.tsx`) renders them next to the
 * gauges. If the two drifted, a driver would read "you work close to the limit"
 * on screen and "you leave grip unused" in the plan with no way to tell which
 * one to believe.
 *
 * Every threshold here is the one documented on `StyleAxes` in
 * `server/ai/driver-profile-aggregate.ts`.
 *
 * `tone` is a severity hint for the UI. It is deliberately not "good = high":
 * grip utilisation above 1.0 is scrubbing, not commitment, and reads as bad.
 */

export type StyleTone = "neutral" | "good" | "warn" | "bad";

export interface StyleReading {
  text: string;
  tone: StyleTone;
}

/** Median friction-circle utilisation. 1.0 = at peak grip. */
export function gripMedianReading(v: number): StyleReading {
  if (v >= 1.0) return { text: "Past the limit for much of the corner — this is scrubbing, not commitment.", tone: "bad" };
  if (v >= 0.85) return { text: "You work very close to the tyres' limit.", tone: "good" };
  if (v >= 0.6) return { text: "You work the tyres in a normal quick-driver range.", tone: "good" };
  return { text: "You leave grip unused through the corner.", tone: "warn" };
}

/** 95th-percentile utilisation — the frames where the driver leans on the car. */
export function gripP95Reading(v: number): StyleReading {
  if (v >= 1.0) return { text: "You do ask the car for everything it has.", tone: "good" };
  if (v >= 0.8) return { text: "You approach the limit but rarely touch it.", tone: "warn" };
  return { text: "You never ask the car for its full grip.", tone: "warn" };
}

/** Signed front−rear slip delta in degrees. Positive = understeer. */
export function balanceReading(v: number): StyleReading {
  const mag = Math.abs(v);
  const dir = v > 0 ? "understeer" : "oversteer";
  if (mag < 1) return { text: "Neutral balance.", tone: "good" };
  if (mag < 4) return { text: `Mild ${dir} lean — within the normal working range.`, tone: "neutral" };
  return { text: `Pronounced ${dir}.`, tone: "warn" };
}

/** Fraction of cornering frames where the car is getting away from the driver. */
export function controlLossReading(v: number): StyleReading {
  if (v <= 0.03) return { text: "You keep the car placed — rotation looks deliberate.", tone: "good" };
  if (v <= 0.1) return { text: "You occasionally have to catch the car.", tone: "warn" };
  return { text: "You spend a lot of the corner catching the car rather than placing it.", tone: "bad" };
}

/** Steering direction reversals per second of cornering. */
export function reversalsReading(v: number): StyleReading {
  if (v <= 2) return { text: "Steering input is settled.", tone: "good" };
  if (v <= 3) return { text: "Some correcting at the wheel.", tone: "warn" };
  return { text: "Sawing at the wheel.", tone: "bad" };
}

/** Median absolute deviation of the slip delta, in degrees. */
export function slipVariabilityReading(v: number): StyleReading {
  if (v <= 1.5) return { text: "You hold the car's attitude steady.", tone: "good" };
  if (v <= 2.5) return { text: "Attitude moves around somewhat.", tone: "warn" };
  return { text: "The car's attitude is not being held.", tone: "bad" };
}

/**
 * −100 (early / over-slowing) … +100 (late / overshooting).
 *
 * The one axis with no absolute scale — read the sign and the size, never as a
 * percentage. Both consumers caption it accordingly.
 */
export function brakingStyleReading(v: number): StyleReading {
  if (v <= -30) return { text: "Leans early / over-slowing.", tone: "warn" };
  if (v >= 30) return { text: "Leans late / overshooting.", tone: "warn" };
  return { text: "No dominant braking-timing pattern.", tone: "neutral" };
}

/** 0–100 lap-time repeatability. */
export function consistencyReading(v: number): StyleReading {
  if (v >= 90) return { text: "Very repeatable.", tone: "good" };
  if (v >= 75) return { text: "Reasonably repeatable.", tone: "neutral" };
  return { text: "Lap times scatter.", tone: "warn" };
}
