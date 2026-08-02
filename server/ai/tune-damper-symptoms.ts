/**
 * damperSymptoms — deterministic damper diagnosis for the auto-tune pipeline
 * (feature #5).
 *
 * The normalized suspension-travel channel (0.0 = full droop / extension,
 * 1.0 = full bump / compression) is the physics-derived evidence for the two
 * damper axes the balance/pressure passes can't see:
 *
 *   - **Travel usage** — the compression band each corner actually works
 *     (p95 − p5). A corner that barely moves is over-sprung / over-damped;
 *     one that rides against the bumpstops is too soft or too low. Persistent
 *     time at full compression is bottoming; time at full droop is a wheel
 *     going light over kerbs/crests.
 *   - **Damper velocity** — the frame-to-frame change in travel is a proxy for
 *     shaft velocity. Splitting it into bump (compressing) vs rebound
 *     (extending) exposes the asymmetry between the two damper directions, and
 *     the fraction of high-velocity events separates the fast (bump/kerb) from
 *     the slow (body-control) side of the histogram a real shock dyno shows.
 *
 * Like tune-symptoms.ts / tune-tire-symptoms.ts this holds no setup knowledge —
 * only observations. The tune-intent LLM turns "FL rides 8% of travel, rebound
 * twice as fast as bump" into a click. Everything is averaged over on-track,
 * moving frames of the stint so a pit stop or spin can't skew a corner.
 *
 * The velocity is a normalized-travel delta per telemetry tick, i.e. it scales
 * with the (fixed, per-game) sample rate. The bump/rebound ratio is rate-free;
 * the fast-event fraction uses a coarse fixed threshold (see
 * {@link FAST_DAMPER_VEL}) that holds for the ACC/AC-EVO channels we support.
 */
import type { TelemetryPacket } from "../../shared/types";
import type { TireCorner } from "./tune-tire-symptoms";

type TravelUse = "stiff" | "optimal" | "soft";
type DamperBias = "bump_biased" | "rebound_biased" | "balanced";

interface DamperCornerSymptom {
  corner: TireCorner;
  /** Mean normalized travel over moving frames (0 = droop, 1 = bump). */
  meanCompression: number;
  /** Working travel band used, (p95 − p5) as a percent of full travel. */
  travelRangePct: number;
  /** Percent of frames pinned at/near full compression (bottoming). */
  bottomingPct: number;
  /** Percent of frames at/near full droop (wheel going light). */
  toppingPct: number;
  /** Mean bump (compression) shaft-velocity proxy, travel-frac per tick. */
  bumpVel: number;
  /** Mean rebound (extension) shaft-velocity proxy, travel-frac per tick. */
  reboundVel: number;
  /** Percent of moving frames whose |velocity| exceeds {@link FAST_DAMPER_VEL}. */
  fastEventPct: number;
  /** Travel-usage read from the working band + bottoming. */
  travelUse: TravelUse;
  /** Bump-vs-rebound velocity asymmetry read. */
  damperBias: DamperBias;
}

interface DamperSymptoms {
  corners: DamperCornerSymptom[];
  /** Mean working-band front axle − rear axle, percent. +ve = fronts busier. */
  frontMinusRearRangePct: number;
  /** Corners bottoming beyond {@link BOTTOMING_PCT}, by label. */
  bottomingCorners: TireCorner[];
  /** Softest corner (widest working band), for quick reference. */
  softestCorner: TireCorner;
  /** Stiffest corner (narrowest working band). */
  stiffestCorner: TireCorner;
}

// Working travel band (%) below which a corner is called over-stiff/over-damped
// and above which it's called soft. Between the two it's "optimal". Coarse
// heuristic — a well-controlled GT car works roughly this band on a smooth
// track; widen per-car later if a lookup lands.
const STIFF_RANGE_PCT = 25;
const SOFT_RANGE_PCT = 70;
// Bump/rebound velocity ratio beyond which the damper is called asymmetric
// rather than "balanced". 1.35 ≈ a third faster one way than the other.
const DAMPER_ASYM_RATIO = 1.35;
// Normalized-travel velocity (per tick) above which a frame counts as a
// fast (bump/kerb) event rather than slow body movement. Fixed coarse
// threshold for the ACC/AC-EVO channels; never a numeric target.
const FAST_DAMPER_VEL = 0.02;
// Percent of frames at full compression that flags a corner as bottoming.
const BOTTOMING_PCT = 2;
// Travel treated as full compression / full droop.
const BUMP_STOP = 0.95;
const DROOP_STOP = 0.05;
// Minimum moving frames before a corner's dampers are trusted.
const MIN_FRAMES = 30;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Percentile of an unsorted array (linear interpolation); 0 when empty. */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function travelUse(rangePct: number): TravelUse {
  if (rangePct < STIFF_RANGE_PCT) return "stiff";
  if (rangePct > SOFT_RANGE_PCT) return "soft";
  return "optimal";
}

function damperBias(bumpVel: number, reboundVel: number): DamperBias {
  if (reboundVel <= 0 && bumpVel <= 0) return "balanced";
  // Guard a zero denominator; a corner that only compresses is bump-biased.
  if (reboundVel <= 0) return "bump_biased";
  if (bumpVel <= 0) return "rebound_biased";
  const ratio = bumpVel / reboundVel;
  if (ratio > DAMPER_ASYM_RATIO) return "bump_biased";
  if (ratio < 1 / DAMPER_ASYM_RATIO) return "rebound_biased";
  return "balanced";
}

/**
 * Reduce a stint to a per-corner damper symptom report, or null when the
 * suspension-travel channel is flat/absent (older games / legacy laps). Frames
 * are filtered to moving, on-track laps: pit/stationary frames carry no shaft
 * velocity and would dilute the working band.
 */
export function damperSymptoms(packets: TelemetryPacket[]): DamperSymptoms | null {
  const moving = packets.filter((p) => (p.Speed ?? 0) > 5);
  if (moving.length < MIN_FRAMES) return null;

  const order: TireCorner[] = ["FL", "FR", "RL", "RR"];
  const travelKey = {
    FL: "NormSuspensionTravelFL",
    FR: "NormSuspensionTravelFR",
    RL: "NormSuspensionTravelRL",
    RR: "NormSuspensionTravelRR",
  } as const;

  // Gate: an unsupported game reports a constant (often 0) travel on every
  // corner. Require at least one corner to show real movement.
  const anyMovement = order.some((c) => {
    const xs = moving.map((p) => p[travelKey[c]]);
    return percentile(xs, 0.95) - percentile(xs, 0.05) > 0.01;
  });
  if (!anyMovement) return null;

  const corners: DamperCornerSymptom[] = order.map((corner) => {
    const travel = moving.map((p) => p[travelKey[corner]]);
    const p5 = percentile(travel, 0.05);
    const p95 = percentile(travel, 0.95);
    const travelRangePct = (p95 - p5) * 100;
    const bottomingPct = (travel.filter((t) => t >= BUMP_STOP).length / travel.length) * 100;
    const toppingPct = (travel.filter((t) => t <= DROOP_STOP).length / travel.length) * 100;

    // Per-tick deltas: +ve compresses (bump), −ve extends (rebound).
    const bumpDeltas: number[] = [];
    const reboundDeltas: number[] = [];
    let fastEvents = 0;
    let motionFrames = 0;
    for (let i = 1; i < travel.length; i++) {
      const d = travel[i] - travel[i - 1];
      if (d === 0) continue;
      motionFrames++;
      if (Math.abs(d) > FAST_DAMPER_VEL) fastEvents++;
      if (d > 0) bumpDeltas.push(d);
      else reboundDeltas.push(-d);
    }
    const bumpVel = mean(bumpDeltas);
    const reboundVel = mean(reboundDeltas);
    const fastEventPct = motionFrames > 0 ? (fastEvents / motionFrames) * 100 : 0;

    return {
      corner,
      meanCompression: mean(travel),
      travelRangePct,
      bottomingPct,
      toppingPct,
      bumpVel,
      reboundVel,
      fastEventPct,
      travelUse: travelUse(travelRangePct),
      damperBias: damperBias(bumpVel, reboundVel),
    };
  });

  const rangeOf = (c: TireCorner) => corners.find((x) => x.corner === c)!.travelRangePct;
  const frontMinusRearRangePct =
    (rangeOf("FL") + rangeOf("FR")) / 2 - (rangeOf("RL") + rangeOf("RR")) / 2;
  const bottomingCorners = corners
    .filter((c) => c.bottomingPct >= BOTTOMING_PCT)
    .map((c) => c.corner);
  const softestCorner = corners.reduce((a, b) =>
    b.travelRangePct > a.travelRangePct ? b : a,
  ).corner;
  const stiffestCorner = corners.reduce((a, b) =>
    b.travelRangePct < a.travelRangePct ? b : a,
  ).corner;

  return {
    corners,
    frontMinusRearRangePct,
    bottomingCorners,
    softestCorner,
    stiffestCorner,
  };
}

/**
 * Render a damper report as prompt prose. Shared by the tune-intent and
 * setup-engineer/tune-chat symptom formatters so both surface the same
 * evidence. `null` (channel flat/absent) collapses to a single line.
 */
export function formatDamperSymptoms(d: DamperSymptoms | null): string {
  if (!d) return "Damper/suspension-travel data unavailable for this game.";
  const useWord: Record<TravelUse, string> = {
    stiff: "narrow band (over-stiff/over-damped)",
    optimal: "healthy band",
    soft: "wide band (soft/under-damped)",
  };
  const biasWord: Record<DamperBias, string> = {
    bump_biased: "bump faster than rebound",
    rebound_biased: "rebound faster than bump",
    balanced: "symmetric",
  };
  const lines = d.corners
    .map((c) => {
      const parts = [
        `travel ${c.travelRangePct.toFixed(0)}% used (${useWord[c.travelUse]})`,
        `mean ${(c.meanCompression * 100).toFixed(0)}% comp`,
        `damper: ${biasWord[c.damperBias]}`,
        `fast events ${c.fastEventPct.toFixed(0)}%`,
        c.bottomingPct >= BOTTOMING_PCT ? `bottoming ${c.bottomingPct.toFixed(0)}%` : null,
      ].filter(Boolean);
      return `  ${c.corner} — ${parts.join(", ")}`;
    })
    .join("\n");
  const bottoming =
    d.bottomingCorners.length > 0 ? d.bottomingCorners.join(", ") : "none";
  return `Dampers (softest ${d.softestCorner}, stiffest ${d.stiffestCorner}; front−rear band ${d.frontMinusRearRangePct.toFixed(0)}%, bottoming: ${bottoming}):
${lines}`;
}
