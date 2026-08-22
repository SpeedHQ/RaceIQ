/**
 * Streaming sampler for frame-based outcome metrics (issue #120, Phase 2).
 *
 * ## Why this exists
 *
 * `inputVarianceBrake`, `inputVarianceThrottle` and `lineSpreadScore` are the
 * core statistics of an input-variance or consistency experiment, so their
 * sample size must not be limited by how much telemetry fits in RAM. The first
 * cut of the loader decoded a whole arm at once behind a `TELEMETRY_LAP_CAP` of
 * 12 laps. Two things were wrong with that: on Nordschleife (~42k frames/lap)
 * 12 laps is hundreds of MB live at once, and *laps* is the wrong unit anyway —
 * 12 Nordschleife laps and 12 Brands Hatch laps differ by ~6x in cost.
 *
 * ## Why streaming is possible at all
 *
 * All three metrics are `"pairwise-frames"` (see `outcome-metrics.ts`): each
 * sample is one lap measured against the arm's ONE reference lap, and the
 * reference is the arm's median-**lap-time** lap — chosen from metadata, so
 * picking it decodes nothing. So the fold is:
 *
 *   decode the reference once and hold it
 *     → for each other lap: decode, reduce to a scalar, drop the frames
 *
 * **Peak live telemetry is 2 laps** (the reference plus the lap in hand),
 * regardless of track length or lap count. Sample size stops being a memory
 * question entirely.
 *
 * ## What is still bounded, and why it is reported
 *
 * Streaming turns decode cost from a memory problem into a LATENCY problem
 * (~100ms/lap; 40 laps x 2 arms would be ~8s inside one HTTP request). So there
 * is still a budget — but in FRAMES, the thing that actually costs time, not in
 * laps. Per CLAUDE.md's no-silent-caps rule, whatever the budget declines to
 * decode is counted into `ArmSummary.droppedByFrameBudget` and stated in
 * `describeComparison`'s one-liner. It is never quietly truncated.
 *
 * The other way an arm's sample can fall short of its curated pool is a lap with
 * no usable frames stored. That is NOT a cap and is reported separately, as
 * `ArmSummary.droppedNoTelemetry` — a driver can drive more laps to fix a budget
 * drop, and cannot do anything about a lap the store never kept frames for. Both
 * counts appear in the one-liner; neither is ever a silent filter.
 *
 * This module is pure: semantic samples arrive through an injected loader, so
 * it has no DB dependency and is testable against synthetic laps.
 * `load.ts` wires resolver replay into it.
 */

import type { SemanticTelemetrySample } from "@shared/telemetry/replay/contracts";
import type { Corner } from "../../lap-analysis/corners";
import type { EvaluableLap } from "../../../shared/racing/laps/review-selection";

import type { PreparedArm } from "./compare";
import { curateLaps, MIN_TELEMETRY_FRAMES, type MetricSample, type PairwiseFramesOutcomeMetric, referenceLapPreference } from "./metrics";

/**
 * Latency budget for one arm, in frames.
 *
 * FRAMES, not laps, deliberately: decode time scales with frames, so a frame
 * budget buys a roughly constant worst-case latency on every track, where a lap
 * cap buys ~6x more on Nordschleife than on Brands Hatch.
 *
 * 300,000 frames at the 60 Hz these games sample at is ~83 minutes of driving:
 * ~50 laps of a 100-second circuit, or ~7 laps of Nordschleife. At the observed
 * ~100ms per ~6k-frame lap that is ~5s of replay per arm worst case. It is set
 * to be generous — above any realistic stint on a short circuit, so the common
 * case never trims at all — while still refusing to spend a minute replaying an
 * entire Nordschleife test day inside one request.
 */
export const FRAME_BUDGET_PER_ARM = 300_000;

/**
 * The lap metadata streaming needs: eligibility (via `EvaluableLap`), recency,
 * and the frame count — `laps.raw_frame_count`, one integer on the row, so the
 * budget is computable without decoding anything.
 */
export interface FrameLapMeta extends EvaluableLap {
  lapNumber: number;
  createdAt: string;
  rawFrameCount?: number | null;
}

/** Replay one lap's semantic samples. Null when no usable telemetry exists. */
export type SemanticSampleLoader = (lapId: number) => Promise<SemanticTelemetrySample[] | null>;

interface StreamArmArgs {
  label: string | null;
  /** The arm's RAW lap pool — curation is the metric's job, done here. */
  metas: FrameLapMeta[];
  metric: PairwiseFramesOutcomeMetric;
  loadSamples: SemanticSampleLoader;
  /**
   * Corners for the fold, resolved once per arm from reference semantic samples.
   * Semantic resolution never falls back to raw packets or detection.
   */
  resolveCorners: (referenceSamples: readonly SemanticTelemetrySample[]) => Promise<Corner[]>;
  frameBudget?: number;
  /**
   * Blunder threshold shared with the other arm (`pooledBlunderFence`). Must be
   * passed whenever this arm is going into a comparison: fencing each arm at its
   * own median+3*IQR censors the two at different thresholds, and the in-memory
   * `compareArms` pools it — leaving this per-arm would silently break the
   * streaming/in-memory equivalence that test/arm-stream.test.ts pins.
   */
  fence?: number | null;
}

/** Most-recent-first: lap number, `createdAt` as tiebreak. */
function byRecencyDesc(x: FrameLapMeta, y: FrameLapMeta): number {
  return y.lapNumber - x.lapNumber || y.createdAt.localeCompare(x.createdAt);
}

interface FrameBudgetSelection {
  /** Laps to decode, in the input order. */
  selected: FrameLapMeta[];
  dropped: FrameLapMeta[];
  /** Frames the selection is expected to cost. */
  frames: number;
}

/**
 * Trim a candidate list to a frame budget, newest laps first.
 *
 * Newest, NOT fastest: trimming by lap time is exactly the order-statistic bias
 * the per-metric curation exists to avoid (see the `outcome-metrics.ts` header).
 * A recency window narrows the sample without reshaping its distribution — and
 * on a tuning run the recent laps are the ones driven with the setup as it
 * finally stood.
 *
 * The window is CONTIGUOUS from the newest lap: the walk stops at the first lap
 * that would breach the budget rather than skipping it to fit smaller older
 * laps. Packing by size would hand the metric a sample selected on lap length —
 * a lap's frame count correlates with how it was driven (a lift, a half-spin,
 * traffic), so "whatever happens to fit" is a quiet selection bias of the same
 * family as fastest-N. A clean recency window has none.
 *
 * The newest lap is always kept even if it alone blows the budget: returning
 * zero samples would be a worse answer than one slow decode.
 */
export function selectWithinFrameBudget(candidates: FrameLapMeta[], budget: number): FrameBudgetSelection {
  const order = [...candidates].sort(byRecencyDesc);
  const keptIds = new Set<number>();
  let frames = 0;

  for (const meta of order) {
    const cost = meta.rawFrameCount ?? 0;
    if (keptIds.size > 0 && frames + cost > budget) break;
    keptIds.add(meta.id);
    frames += cost;
  }

  return {
    selected: candidates.filter((m) => keptIds.has(m.id)),
    dropped: candidates.filter((m) => !keptIds.has(m.id)),
    frames,
  };
}

/**
 * Sample one arm on a pairwise-frames metric, holding at most 2 laps of
 * telemetry live at any moment.
 *
 * Produces exactly the samples `extractSamples(metric, ...)` would produce over
 * the same laps, in the same order — pinned by test/arm-stream.test.ts.
 */
export async function streamArmSamples(args: StreamArmArgs): Promise<PreparedArm> {
  const { label, metas, metric, loadSamples, resolveCorners } = args;
  const budget = args.frameBudget ?? FRAME_BUDGET_PER_ARM;

  // Curate over the WHOLE pool first: it is metadata-only, so it is free, and
  // the blunder fence wants to see every lap before anything is trimmed.
  const pool = curateLaps<EvaluableLap>(metas, metric.curation, { fence: args.fence });
  const keptIds = new Set(pool.kept.map((l) => l.id));

  // A lap with no stored frames can never yield a sample; it must not eat a
  // budget slot a decodable lap could have used. Counted, not silently
  // filtered — it is a real gap between the arm's curated pool and its sample
  // size, and it is reported separately from a budget drop because the two mean
  // different things (see `describeBudgetDrop`).
  const curated = metas.filter((m) => keptIds.has(m.id));
  const candidates = curated.filter((m) => (m.rawFrameCount ?? 0) >= MIN_TELEMETRY_FRAMES);
  // `let`, because a lap whose row claims enough frames can still decode to
  // nothing; the fold below counts those the same way. `empty()` closes over
  // the binding, so a late return still reports the current total.
  let droppedNoTelemetry = curated.length - candidates.length;
  const budgeted = selectWithinFrameBudget(candidates, budget);

  const empty = (framesDecoded: number | null): PreparedArm => ({
    label,
    rawLapCount: metas.length,
    pool,
    samples: [],
    droppedByFrameBudget: budgeted.dropped.length,
    droppedNoTelemetry,
    framesDecoded,
  });

  // Same floor as the in-memory path: a pairwise sample needs a partner.
  if (budgeted.selected.length < 2) return empty(null);

  // ── one lap live: the reference ──────────────────────────────────────────
  let reference: { id: number; samples: SemanticTelemetrySample[] } | null = null;
  let framesDecoded = 0;
  for (const candidate of referenceLapPreference(budgeted.selected)) {
    const samples = await loadSamples(candidate.id);
    if (samples && samples.length >= MIN_TELEMETRY_FRAMES) {
      reference = { id: candidate.id, samples };
      framesDecoded += samples.length;
      break;
    }
  }
  if (!reference) return empty(null);

  const corners = await resolveCorners(reference.samples);
  if (corners.length < 1) return empty(framesDecoded);

  // ── two laps live: the reference plus the lap in hand ────────────────────
  const samples: MetricSample[] = [];
  for (const meta of budgeted.selected) {
    if (meta.id === reference.id) continue;
    const lapSamples = await loadSamples(meta.id);
    if (!lapSamples || lapSamples.length < MIN_TELEMETRY_FRAMES) {
      // The row's `raw_frame_count` promised frames the replay could not
      // produce. Same class of gap as a lap with no telemetry at all.
      droppedNoTelemetry++;
      continue;
    }
    framesDecoded += lapSamples.length;
    const value = metric.reduce({ lap: meta, samples: lapSamples, referenceSamples: reference.samples, corners });
    if (value != null && Number.isFinite(value)) samples.push({ lapId: meta.id, value });
    // `lapSamples` goes out of scope here — nothing accumulates samples.
  }

  return {
    label,
    rawLapCount: metas.length,
    pool,
    samples,
    droppedByFrameBudget: budgeted.dropped.length,
    droppedNoTelemetry,
    framesDecoded,
  };
}
