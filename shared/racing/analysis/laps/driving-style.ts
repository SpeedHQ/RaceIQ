import { tryGetGame } from "../../../games/registry";
import type { GameId } from "../../../games/ids";
import type { TelemetryPacket } from "../../../telemetry/types";
import { frameDt } from "./frame-time";
import { LAT_G_FLOOR, SPEED_FLOOR, allFrictionCircle, steerBalance } from "./physics/vehicle";

/**
 * Continuous driving-style measurement for a single lap.
 *
 * The point of this module is that every number it emits is a *physical
 * quantity on a calibrated scale*, not a count of threshold crossings.
 *
 * The predecessor of these axes was built from detector event counts —
 * "how often did the wheelspin detector fire, weighted by its severity label".
 * That basis has no absolute meaning: a driver with warning-severity wheelspin
 * on every single lap scored ~28/100 "aggression", because reaching 100 would
 * have required every detector in the pool firing at critical severity on every
 * lap. The number read as a percentage and was in fact only comparable to other
 * numbers produced by the same code. Worse, a threshold crossing is a *proxy*
 * for what we actually want to know — how close to the tyres' limit the driver
 * works, and how often the car gets away from them.
 *
 * So everything here is measured per frame off `shared/racing/analysis/laps/physics/vehicle.ts`,
 * which already normalises against documented peak-grip references
 * (`SLIP_RATIO_PEAK` 0.12, `SLIP_ANGLE_PEAK_RAD` 8°). On that scale 1.0 means
 * "at the limit" — an absolute claim that survives being shown to a driver.
 *
 * Three rules the rest of the file obeys:
 *
 *  1. **Gate before you classify.** Only frames that are demonstrably cornering
 *     are measured. `vehicle-physics.ts` documents the trap in detail: on a
 *     straight, drive-wheel spin loads the rear friction circle and a naive
 *     reading calls it oversteer. The `|latG| ≥ LAT_G_FLOOR` / `V ≥ SPEED_FLOOR`
 *     gates exist precisely to stop that, and are reused verbatim here.
 *  2. **Absent ≠ zero.** A statistic that could not be measured is `undefined`,
 *     never 0. Reporting 0° of balance for a lap with no cornering frames is a
 *     claim the data does not support — the same distinction `timeLossS` draws
 *     in `shared/racing/analysis/laps/insights/types.ts`.
 *  3. **Robust central tendency.** Medians and MADs throughout. One dropped
 *     wheel or one off-track excursion must not redefine the driver.
 *
 * Pure and isomorphic: no I/O, no DB, no clock, no randomness. The same frames
 * in always give a deeply-equal summary out.
 */

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

/**
 * Cornering frames needed before a lap's style statistics mean anything.
 * ~1 second at 60 Hz. Below this the medians are dominated by whichever handful
 * of frames happened to clear the lateral-g gate, which is noise wearing the
 * costume of a driving style.
 */
export const MIN_CORNERING_FRAMES = 60;

/**
 * Yaw-rate error (rad/s) above which the car is rotating meaningfully faster
 * than the path it is on. Half of `vehicle-physics.ts`'s `YAW_ERR_SCALE` (0.3
 * rad/s = "full severity"), i.e. the midpoint of an already-documented scale
 * rather than a fresh magic number.
 */
export const CONTROL_LOSS_YAW_ERR = 0.15;

/**
 * Steering movement (fraction of full lock) that must be reversed before it
 * counts as a direction change. Filters input quantisation and hand tremor;
 * 3% of lock is well below any deliberate correction.
 */
const STEER_REVERSAL_DEADBAND = 0.03;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/**
 * Continuous style statistics for one lap.
 *
 * Units are stated per field and are never rescaled to a 0–100 "score". Where a
 * quantity is genuinely dimensionless it is on the friction-circle scale, where
 * 1.0 is a documented physical reference (peak grip), not an arbitrary maximum.
 */
export interface LapStyleSummary {
  /** Total telemetry frames considered. */
  frames: number;
  /** Frames that cleared the cornering gate (see `isCornering`). */
  corneringFrames: number;
  /** Seconds of cornering, integrated from real packet timestamps. */
  corneringSeconds: number;
  /**
   * False when `corneringFrames < MIN_CORNERING_FRAMES`. Every statistic below
   * is `undefined` in that case — an unusable lap says so instead of emitting
   * medians of a dozen frames.
   */
  usable: boolean;

  // ── Grip utilisation — how close to the tyres' limit the driver works ────
  /**
   * Median four-wheel friction-circle utilisation over cornering frames.
   * Dimensionless, calibrated: **1.0 = at peak grip**, >1 = past peak (the
   * tyre is sliding, not gripping).
   *
   * Reasoning about the scale (not an empirical survey): peak slip angle is 8°,
   * so a car held at a steady 4° mid-corner reads ≈0.5 and one at 7° reads
   * ≈0.9. A quick driver's *median* sits around 0.6–0.85 — the median covers
   * the whole corner including entry and exit, so it is structurally below the
   * peak. A median at or above 1.0 is not commitment, it is scrubbing.
   */
  gripUtilMedian?: number;
  /**
   * 95th percentile of the same quantity — the frames where the driver is
   * actually leaning on the car. 1.0 means the limit is being touched; ~1.0–1.4
   * is what committed driving looks like; below ~0.8 the car is never asked for
   * everything it has. This, not a detector count, is the honest "aggression".
   */
  gripUtilP95?: number;

  // ── Balance — which end gives up first, in real degrees ─────────────────
  /**
   * Median signed front−rear slip-angle delta over cornering frames, in
   * **degrees**. Positive = understeer-leaning, negative = oversteer-leaning.
   * Deliberately left as degrees rather than mapped to an index: ±1–3° is the
   * normal working range for a balanced car, beyond ±4° the bias is pronounced.
   */
  balanceMedianDeg?: number;
  /**
   * Fraction of cornering frames `steerBalance` classifies as understeer /
   * oversteer. 0–1. These use the same classifier the analyse view shows, so a
   * driver reading both sees consistent verdicts.
   */
  understeerFraction?: number;
  oversteerFraction?: number;

  // ── Control loss — the car getting away from the driver ─────────────────
  /**
   * Fraction of cornering frames (0–1) where the body is rotating faster than
   * the path demands *and* the rear is carrying more slip angle than the front:
   * `yawError > CONTROL_LOSS_YAW_ERR && slipDelta < 0`.
   *
   * The second condition is not optional. Yaw-rate error alone can be produced
   * by drive torque and differential effects without the rear tyres giving up
   * anything, which is the exact misread `vehicle-physics.ts` warns about; slip
   * angle is lateral-only and immune to it, so requiring both means a frame is
   * only called "loose" when the tyres corroborate the gyro.
   *
   * 0 is normal. Clean laps sit in the 0–0.03 range because a rotating car on
   * corner entry is deliberate. Sustained values past ~0.10 mean the driver is
   * catching the car rather than placing it.
   */
  controlLossFraction?: number;

  // ── Smoothness — variability, explicitly NOT magnitude ──────────────────
  /**
   * Steering direction reversals per second of cornering, counted with a
   * hysteretic turning-point detector (`STEER_REVERSAL_DEADBAND` of full lock).
   *
   * Deliberately a *rate of reversal*, not a rate of movement: a fast chicane
   * needs large, quick steering inputs and that is not roughness. Turning the
   * wheel one way and back repeatedly within a single corner is.
   *
   * Roughly 0.5–2 /s is ordinary (each corner contributes its own turn-in and
   * unwind); past ~3 /s the driver is sawing.
   *
   * `undefined` when the game adapter for `gameId` is not registered — steering
   * is raw game units and cannot be normalised without it. Not zero: unknown.
   */
  steerReversalsPerS?: number;
  /**
   * Median absolute deviation of the signed slip delta about its own median,
   * in **degrees**. This is the "steady 6° is smooth, oscillating 0–8° is not"
   * measure: it is blind to how much slip the driver carries and sees only how
   * much that number moves around.
   *
   * ~0.5–1.5° is ordinary across a whole lap (different corners genuinely load
   * the car differently); past ~2.5° the car's attitude is not being held.
   */
  slipVariabilityDeg?: number;
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** Median of an already-populated array. Returns undefined for an empty one. */
export function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Linear-interpolated quantile, q in [0, 1]. Undefined for an empty array. */
export function quantile(values: number[], q: number): number | undefined {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/**
 * Median absolute deviation about the median. Chosen over standard deviation
 * because one wheel-drop spike would otherwise redefine a driver's smoothness;
 * MAD ignores anything past the middle of the distribution.
 */
export function medianAbsDeviation(values: number[]): number | undefined {
  const m = median(values);
  if (m === undefined) return undefined;
  return median(values.map((v) => Math.abs(v - m)));
}

/** Round for storage/comparison so float noise can't make two identical laps differ. */
function round4(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

/**
 * Is this frame actually cornering?
 *
 * Reuses `steerBalance`'s own gates rather than inventing parallel ones — the
 * thresholds are documented there (`LAT_G_FLOOR` 0.25 g, `SPEED_FLOOR` 5 m/s)
 * and the whole point is that this module and the analyse view agree about when
 * a frame may be classified at all.
 *
 * The floors are imported from vehicle-physics rather than restated, so the two
 * modules cannot drift into disagreeing about what counts as cornering.
 */
const G = 9.81;

export function isCornering(pkt: TelemetryPacket): boolean {
  const latG = Math.abs(-pkt.AccelerationX / G);
  return Number.isFinite(latG) && latG >= LAT_G_FLOOR && pkt.Speed >= SPEED_FLOOR;
}

// ---------------------------------------------------------------------------
// Steering normalisation
// ---------------------------------------------------------------------------

/**
 * Steering as a fraction of full lock, −1 (full left) … +1 (full right).
 *
 * Games do not agree on the raw encoding: Forza centres at 127, while F1 2025,
 * ACC and AC Evo centre at 0 (see each adapter under `shared/games/`). Both the
 * centre and the range come from each game's adapter, so this is the one genuinely
 * game-dependent quantity in the module — slip angles are radians everywhere
 * (documented in vehicle-physics.ts) and speed/acceleration are SI, so nothing
 * else needs per-game handling.
 *
 * Returns undefined when the adapter is not registered. Guessing a centre would
 * turn a full-lock corner into a straight or vice versa, and there is no safe
 * default: FM's 127 and everyone else's 0 are both wrong for the other.
 */
function normalisedSteer(telemetry: TelemetryPacket[], gameId: GameId): number[] | undefined {
  const adapter = tryGetGame(gameId);
  if (!adapter) return undefined;
  const centre = adapter.steeringCenter;
  const range = adapter.steeringRange || 1;
  return telemetry.map((p) => Math.max(-1, Math.min(1, (p.Steer - centre) / range)));
}

/**
 * Hysteretic turning-point count over a set of frame indices.
 *
 * Standard reversal counting: track the running extreme in the current
 * direction, and only call a reversal once the signal has retraced past the
 * deadband. `indices` may be non-contiguous (cornering frames are scattered
 * across a lap); the detector resets at every gap so the jump from one corner's
 * exit to the next corner's entry is never counted as an input.
 */
function countReversals(steer: number[], indices: number[], deadband: number): number {
  let reversals = 0;
  let dir = 0;
  let extreme = 0;
  let prevIdx = -2;

  for (const i of indices) {
    const v = steer[i];
    if (i !== prevIdx + 1) {
      // Discontinuity — start a fresh run rather than bridging two corners.
      dir = 0;
      extreme = v;
    }
    prevIdx = i;

    if (dir === 0) {
      if (v > extreme + deadband) {
        dir = 1;
        extreme = v;
      } else if (v < extreme - deadband) {
        dir = -1;
        extreme = v;
      } else if (v > extreme) {
        extreme = v;
      }
    } else if (dir === 1) {
      if (v > extreme) extreme = v;
      else if (v < extreme - deadband) {
        reversals++;
        dir = -1;
        extreme = v;
      }
    } else {
      if (v < extreme) extreme = v;
      else if (v > extreme + deadband) {
        reversals++;
        dir = 1;
        extreme = v;
      }
    }
  }
  return reversals;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** A summary for a lap that produced no usable measurement. */
function unusable(frames: number, corneringFrames: number, corneringSeconds: number): LapStyleSummary {
  return { frames, corneringFrames, corneringSeconds: round4(corneringSeconds), usable: false };
}

/**
 * Reduce one lap's telemetry to continuous style statistics.
 *
 * Every statistic is computed over the *same* set of cornering frames, so the
 * fractions are mutually comparable and a driver can be told "12% of your
 * cornering was spent catching the rear" without that percentage silently
 * having a different denominator to the balance figure next to it.
 */
export function summariseLapStyle(telemetry: TelemetryPacket[], gameId: GameId): LapStyleSummary {
  const frames = telemetry.length;
  if (frames === 0) return unusable(0, 0, 0);

  const dt = frameDt(telemetry);

  const corneringIdx: number[] = [];
  let corneringSeconds = 0;
  for (let i = 0; i < frames; i++) {
    if (!isCornering(telemetry[i])) continue;
    corneringIdx.push(i);
    corneringSeconds += dt[i];
  }

  if (corneringIdx.length < MIN_CORNERING_FRAMES) {
    return unusable(frames, corneringIdx.length, corneringSeconds);
  }

  const grip: number[] = [];
  const slipDelta: number[] = [];
  let understeer = 0;
  let oversteer = 0;
  let controlLoss = 0;

  for (const i of corneringIdx) {
    const p = telemetry[i];

    const fc = allFrictionCircle(p);
    const mean = (fc.fl + fc.fr + fc.rl + fc.rr) / 4;
    // Car-level demand, not one tyre's: a single wheel momentarily past peak
    // (kerb strike, inside wheel unloaded) is not the car at its limit.
    if (Number.isFinite(mean)) grip.push(mean);

    const b = steerBalance(p);
    if (Number.isFinite(b.slipDelta)) slipDelta.push(b.slipDelta);
    if (b.state === "understeer") understeer++;
    else if (b.state === "oversteer") oversteer++;

    // Gyro says over-rotating AND tyres agree the rear is the end letting go.
    if (b.yawError > CONTROL_LOSS_YAW_ERR && b.slipDelta < 0) controlLoss++;
  }

  const n = corneringIdx.length;
  const summary: LapStyleSummary = {
    frames,
    corneringFrames: n,
    corneringSeconds: round4(corneringSeconds),
    usable: true,
    understeerFraction: round4(understeer / n),
    oversteerFraction: round4(oversteer / n),
    controlLossFraction: round4(controlLoss / n),
  };

  const gm = median(grip);
  if (gm !== undefined) summary.gripUtilMedian = round4(gm);
  const gp = quantile(grip, 0.95);
  if (gp !== undefined) summary.gripUtilP95 = round4(gp);

  const bm = median(slipDelta);
  if (bm !== undefined) summary.balanceMedianDeg = round4(bm);
  const sv = medianAbsDeviation(slipDelta);
  if (sv !== undefined) summary.slipVariabilityDeg = round4(sv);

  const steer = normalisedSteer(telemetry, gameId);
  if (steer && corneringSeconds > 0) {
    summary.steerReversalsPerS = round4(countReversals(steer, corneringIdx, STEER_REVERSAL_DEADBAND) / corneringSeconds);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Cross-lap aggregation
// ---------------------------------------------------------------------------

/**
 * The same statistics, medianed across a pool of laps.
 *
 * Median rather than mean, per field, over the laps that measured that field.
 * A driver who puts two wheels on the grass once in fifteen laps has one lap
 * with a wild `controlLossFraction`; a mean would let it define them, a median
 * lets the other fourteen laps outvote it. Each field is medianed independently
 * so one lap missing (say) steering never removes it from the grip statistics.
 */
export interface StyleAggregate extends Omit<LapStyleSummary, "frames" | "corneringFrames" | "corneringSeconds" | "usable"> {
  /** Laps that contributed (i.e. were `usable`). */
  lapsUsable: number;
  /** Laps offered, including unusable ones. */
  lapsConsidered: number;
}

export function aggregateLapStyles(summaries: readonly LapStyleSummary[]): StyleAggregate {
  const usable = summaries.filter((s) => s.usable);
  const pick = (get: (s: LapStyleSummary) => number | undefined): number | undefined => {
    const vs: number[] = [];
    for (const s of usable) {
      const v = get(s);
      if (v !== undefined && Number.isFinite(v)) vs.push(v);
    }
    const m = median(vs);
    return m === undefined ? undefined : round4(m);
  };

  // Each field is spread only when a median exists, so an unmeasurable axis is
  // an ABSENT key rather than a present `undefined` — same distinction the rest
  // of the profile draws between "not measured" and a real value.
  const opt = (key: string, get: (s: LapStyleSummary) => number | undefined): Record<string, number> => {
    const v = pick(get);
    return v === undefined ? {} : { [key]: v };
  };

  return {
    lapsUsable: usable.length,
    lapsConsidered: summaries.length,
    ...opt("gripUtilMedian", (s) => s.gripUtilMedian),
    ...opt("gripUtilP95", (s) => s.gripUtilP95),
    ...opt("balanceMedianDeg", (s) => s.balanceMedianDeg),
    ...opt("understeerFraction", (s) => s.understeerFraction),
    ...opt("oversteerFraction", (s) => s.oversteerFraction),
    ...opt("controlLossFraction", (s) => s.controlLossFraction),
    ...opt("steerReversalsPerS", (s) => s.steerReversalsPerS),
    ...opt("slipVariabilityDeg", (s) => s.slipVariabilityDeg),
  };
}
