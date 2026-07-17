/**
 * weightTransferSymptoms — deterministic weight-transfer diagnosis for the
 * auto-tune pipeline (feature #8).
 *
 * The per-corner vertical wheel load (N) is the most direct evidence for
 * mechanical balance there is. Two reads matter for setup:
 *
 *   - **Lateral load-transfer distribution (LLTD)** — under cornering, load
 *     shifts from the inside to the outside wheels. The *share* of that
 *     transfer taken by the front axle vs the rear is what roll-stiffness tools
 *     (ARBs, spring split, roll centres) move. A front-biased LLTD loads the
 *     outer front harder and pushes the car toward understeer; a rear bias
 *     pushes it toward oversteer. This is the single richest balance signal and
 *     it's meaningful *per corner*, so it's attached to each CornerSymptom.
 *   - **Longitudinal transfer** — braking pitches load onto the front axle
 *     (dive), throttle onto the rear (squat). The peak front-axle load gain
 *     under braking corroborates brake-bias and front-spring reads.
 *
 * Like the other symptom modules this holds no setup knowledge — only
 * observations. The tune-intent LLM turns "LLTD 58% front" into an ARB click.
 * Everything is averaged over loaded, on-track frames so a single event can't
 * skew a read.
 *
 * The wheelLoad channel (physics offsets 72-84) is ACC/AC-EVO only. When it's
 * absent {@link weightTransferSymptoms} still returns the g-force envelope from
 * AccelerationX/Y (present on every game) but leaves the load-derived fields
 * null, and callers omit the LLTD context.
 */
import type { TelemetryPacket } from "../../shared/types";

export type BalanceLean = "front" | "rear" | "even";

export interface CornerLoad {
  /** Front share of lateral load transfer during the corner (0..1); null when
   *  the wheelLoad channel is absent. >0.5 = front-biased → understeer-prone. */
  lltdFront: number | null;
  /** Peak lateral g magnitude during the corner. */
  peakLatG: number;
}

export interface WeightTransferSymptoms {
  /** Mean front share of lateral load transfer across loaded frames (0..1);
   *  null when wheelLoad is absent. >0.5 = front roll stiffness bias. */
  lltdFront: number | null;
  /** Coarse read of {@link lltdFront} vs an even 50/50 split. */
  lltdLean: BalanceLean;
  /** Static front weight distribution from near-zero-g frames (0..1); null
   *  when wheelLoad is absent. */
  frontStaticBias: number | null;
  /** Peak lateral g magnitude in the stint. */
  peakLatG: number;
  /** Peak braking g (positive magnitude). */
  peakBrakeG: number;
  /** Peak acceleration g (positive magnitude). */
  peakAccelG: number;
  /** Mean front-axle load gain under braking vs the static baseline, N; null
   *  when wheelLoad is absent. */
  brakeDiveLoadN: number | null;
}

// Lateral g above which a frame is "cornering" and its lateral transfer counts
// toward the LLTD. Below this the inner/outer split is sensor noise.
export const CORNER_LAT_G = 0.4;
// Longitudinal g magnitude above which a frame is braking / accelerating.
export const LONG_G = 0.3;
// |LLTD − 0.5| beyond which the balance is called front/rear rather than even.
export const LLTD_LEAN_BAND = 0.04;
// Lateral + longitudinal g both under this ⇒ load is ~static (baseline).
export const STATIC_G = 0.15;
// Minimum frames before a read is trusted.
const MIN_FRAMES = 30;
// gravity, m/s² — AccelerationX/Y are m/s²; convert to g for readable output.
const G = 9.81;

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Lateral g magnitude of a frame (AccelerationY is lateral, m/s²). */
function latG(p: TelemetryPacket): number {
  return Math.abs(p.AccelerationY ?? 0) / G;
}
/** Longitudinal g (signed: +ve accel, −ve braking). */
function longG(p: TelemetryPacket): number {
  return (p.AccelerationX ?? 0) / G;
}

/**
 * Front share of lateral load transfer over a set of cornering frames, or null
 * when the wheelLoad channel is absent. Per frame the front transfer is the
 * inner/outer load gap on the front axle, likewise the rear; the front share is
 * meanFront / (meanFront + meanRear).
 */
export function lltdFrontOf(frames: TelemetryPacket[]): number | null {
  const loaded = frames.filter((p) => p.wheelLoad != null && latG(p) > CORNER_LAT_G);
  if (loaded.length < 3) return null;
  const frontTransfer = mean(loaded.map((p) => Math.abs(p.wheelLoad![0] - p.wheelLoad![1])));
  const rearTransfer = mean(loaded.map((p) => Math.abs(p.wheelLoad![2] - p.wheelLoad![3])));
  const total = frontTransfer + rearTransfer;
  if (total <= 0) return null;
  return frontTransfer / total;
}

function lltdLean(lltdFront: number | null): BalanceLean {
  if (lltdFront == null) return "even";
  if (lltdFront > 0.5 + LLTD_LEAN_BAND) return "front";
  if (lltdFront < 0.5 - LLTD_LEAN_BAND) return "rear";
  return "even";
}

/** Per-corner load read for a corner's frames, for CornerSymptom integration. */
export function cornerWeightTransfer(frames: TelemetryPacket[]): CornerLoad {
  const peakLatG = frames.reduce((m, p) => Math.max(m, latG(p)), 0);
  return { lltdFront: lltdFrontOf(frames), peakLatG };
}

/**
 * Reduce a stint to a weight-transfer symptom report. Returns the g-force
 * envelope always (AccelerationX/Y are universal); the load-derived LLTD and
 * dive fields are null when the wheelLoad channel is absent.
 */
export function weightTransferSymptoms(packets: TelemetryPacket[]): WeightTransferSymptoms | null {
  const moving = packets.filter((p) => (p.Speed ?? 0) > 5);
  if (moving.length < MIN_FRAMES) return null;

  const peakLatG = moving.reduce((m, p) => Math.max(m, latG(p)), 0);
  const peakBrakeG = moving.reduce((m, p) => Math.max(m, Math.max(0, -longG(p))), 0);
  const peakAccelG = moving.reduce((m, p) => Math.max(m, Math.max(0, longG(p))), 0);

  const lltdFront = lltdFrontOf(moving);

  // Static front weight share from near-stationary-load frames.
  const hasLoad = moving.some((p) => p.wheelLoad != null);
  let frontStaticBias: number | null = null;
  let brakeDiveLoadN: number | null = null;
  if (hasLoad) {
    const staticFrames = moving.filter(
      (p) => p.wheelLoad != null && latG(p) < STATIC_G && Math.abs(longG(p)) < STATIC_G,
    );
    if (staticFrames.length >= 3) {
      const frontStatic = mean(staticFrames.map((p) => p.wheelLoad![0] + p.wheelLoad![1]));
      const totalStatic = mean(
        staticFrames.map((p) => p.wheelLoad![0] + p.wheelLoad![1] + p.wheelLoad![2] + p.wheelLoad![3]),
      );
      frontStaticBias = totalStatic > 0 ? frontStatic / totalStatic : null;

      // Front-axle load gain under braking vs that static baseline.
      const brakeFrames = moving.filter((p) => p.wheelLoad != null && longG(p) < -LONG_G);
      if (brakeFrames.length >= 3) {
        const frontBraking = mean(brakeFrames.map((p) => p.wheelLoad![0] + p.wheelLoad![1]));
        brakeDiveLoadN = frontBraking - frontStatic;
      }
    }
  }

  return {
    lltdFront,
    lltdLean: lltdLean(lltdFront),
    frontStaticBias,
    peakLatG,
    peakBrakeG,
    peakAccelG,
    brakeDiveLoadN,
  };
}

/**
 * Render a weight-transfer report as prompt prose. Shared by the tune-intent
 * and setup-engineer/tune-chat symptom formatters. `null` collapses to a
 * single unavailable line.
 */
export function formatWeightTransferSymptoms(w: WeightTransferSymptoms | null): string {
  if (!w) return "Weight-transfer data unavailable for this game.";
  const leanWord: Record<BalanceLean, string> = {
    front: "front-biased (understeer-prone)",
    rear: "rear-biased (oversteer-prone)",
    even: "even",
  };
  const parts = [
    `peak g: ${w.peakLatG.toFixed(1)} lat, ${w.peakBrakeG.toFixed(1)} brake, ${w.peakAccelG.toFixed(1)} accel`,
  ];
  if (w.lltdFront != null) {
    parts.push(
      `LLTD ${(w.lltdFront * 100).toFixed(0)}% front (${leanWord[w.lltdLean]})`,
    );
  }
  if (w.frontStaticBias != null) {
    parts.push(`static ${(w.frontStaticBias * 100).toFixed(0)}% front`);
  }
  if (w.brakeDiveLoadN != null) {
    parts.push(`brake dive +${w.brakeDiveLoadN.toFixed(0)}N front`);
  }
  return `Weight transfer: ${parts.join("; ")}.`;
}
