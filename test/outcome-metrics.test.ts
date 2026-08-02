import { describe, expect, test } from "bun:test";
import {
  blunderFence,
  type CurationSpec,
  curateLaps,
  extractSamples,
  getOutcomeMetric,
  metricNeedsTelemetry,
  OUTCOME_METRIC_IDS,
  OUTCOME_METRICS,
  pickReferenceLap,
} from "../server/experiments/comparison/metrics";
import type { EvaluableLap } from "../shared/review-laps";

/** The policy no metric uses any more, kept explicit so its effects stay
 *  measurable. See `lapTimeSec`'s comment in server/experiments/comparison/metrics.ts. */
const FASTEST_5: CurationSpec = { mode: "fastest-n", n: 5, outlierRule: "none" };

function lap(overrides: Partial<EvaluableLap> & { id: number }): EvaluableLap {
  return {
    lapTime: 90,
    isValid: true,
    invalidReason: null,
    experimentExcluded: false,
    experimentExcludedSource: null,
    ...overrides,
  };
}

/** 8 laps, 90.0 .. 90.7 — a normal-looking spread with a real slow tail. */
function stint(times: number[], base = 1): EvaluableLap[] {
  return times.map((t, i) => lap({ id: base + i, lapTime: t }));
}

/**
 * The reference-lap rule needs its own test, and the streaming/in-memory
 * equivalence test in test/arm-stream.test.ts cannot be it: both paths call
 * `pickReferenceLap`, so a change to the rule moves both sides together and
 * equivalence still holds. Swapping median for fastest passed the entire suite
 * until this block existed.
 *
 * The rule is load-bearing rather than arbitrary. The reference is what every
 * other lap's deviation is measured against, so picking the fastest lap — often
 * a flyer, and by definition an extreme of the distribution — inflates every
 * sample and makes an arm look less consistent than it drove.
 */
describe("reference lap is the median by lap time, not the fastest", () => {
  const entry = (id: number, lapTime: number) => ({ lap: lap({ id, lapTime }) });

  test("picks the middle lap, not the quickest", () => {
    const entries = [entry(1, 91.5), entry(2, 90.0), entry(3, 90.5), entry(4, 92.0), entry(5, 90.8)];
    const picked = pickReferenceLap(entries);
    // Sorted: 90.0(2) 90.5(3) 90.8(5) 91.5(1) 92.0(4) → median is lap 5.
    expect(picked?.lap.id).toBe(5);
    expect(picked?.lap.lapTime).toBe(90.8);
  });

  test("a flyer does not become the reference", () => {
    // One lap a full second clear of a tight pack: exactly the case where using
    // the fastest lap would inflate every other lap's measured deviation.
    const entries = [entry(1, 89.0), entry(2, 90.4), entry(3, 90.5), entry(4, 90.6), entry(5, 90.7)];
    const picked = pickReferenceLap(entries);
    expect(picked?.lap.id).not.toBe(1);
    expect(picked?.lap.lapTime).toBe(90.5);
  });

  test("even-length pools take the lower-middle lap, deterministically", () => {
    const entries = [entry(1, 90.0), entry(2, 90.2), entry(3, 90.4), entry(4, 90.6)];
    expect(pickReferenceLap(entries)?.lap.id).toBe(2);
  });

  test("ties break on lap id, so the pick never depends on input order", () => {
    const forward = [entry(1, 90.0), entry(2, 90.0), entry(3, 90.0)];
    const reversed = [entry(3, 90.0), entry(2, 90.0), entry(1, 90.0)];
    expect(pickReferenceLap(forward)?.lap.id).toBe(pickReferenceLap(reversed)?.lap.id);
  });

  test("empty pool has no reference", () => {
    expect(pickReferenceLap([])).toBeNull();
  });
});

describe("curation policy is per-metric", () => {
  test("no shipped metric ranks laps away — every one is all-valid + blunder fence", () => {
    // Fastest-N is what the review UI shows, but it hands a t-test order
    // statistics instead of an iid sample. test/compare-arms.test.ts measures
    // what that does to a p-value; nothing here is allowed to opt into it.
    for (const id of OUTCOME_METRIC_IDS) {
      const metric = getOutcomeMetric(id);
      expect(metric.curation.mode).toBe("all-valid");
      expect(metric.curation.outlierRule).toBe("blunder-fence");
    }
  });

  test("every registered id resolves to a metric with that id, in a known sampling mode", () => {
    for (const id of OUTCOME_METRIC_IDS) {
      expect(getOutcomeMetric(id).id).toBe(id);
    }
    expect(metricNeedsTelemetry(OUTCOME_METRICS.lapTimeSec)).toBe(false);
    expect(metricNeedsTelemetry(OUTCOME_METRICS.consistencySpreadSec)).toBe(false);
    expect(metricNeedsTelemetry(OUTCOME_METRICS.inputVarianceBrake)).toBe(true);
    expect(metricNeedsTelemetry(OUTCOME_METRICS.inputVarianceThrottle)).toBe(true);
    expect(metricNeedsTelemetry(OUTCOME_METRICS.lineSpreadScore)).toBe(true);
  });

  test("fastest-N truncates the tail; all-valid keeps it", () => {
    const laps = stint([90.0, 90.1, 90.2, 90.3, 90.4, 90.5, 90.6, 90.7]);

    const fastest = curateLaps(laps, FASTEST_5);
    expect(fastest.kept.map((l) => l.id)).toEqual([1, 2, 3, 4, 5]);
    expect(fastest.droppedByCap).toBe(3);

    const all = curateLaps(laps, OUTCOME_METRICS.consistencySpreadSec.curation);
    expect(all.kept.length).toBe(8);
    expect(all.droppedByCap).toBe(0);
    expect(all.droppedOutliers).toBe(0);
  });

  test("all-valid ignores persisted fastest-5 auto exclusions but honours manual ones", () => {
    // What the auto pass leaves behind: laps 6-8 stamped (excluded, 'auto')
    // purely because they lost the lap-time ranking. Lap 4 is a human's call.
    const laps = [
      lap({ id: 1, lapTime: 90.0 }),
      lap({ id: 2, lapTime: 90.1 }),
      lap({ id: 3, lapTime: 90.2 }),
      lap({ id: 4, lapTime: 90.25, experimentExcluded: true, experimentExcludedSource: "manual" }),
      lap({ id: 5, lapTime: 90.3 }),
      lap({ id: 6, lapTime: 90.4, experimentExcluded: true, experimentExcludedSource: "auto" }),
      lap({ id: 7, lapTime: 90.5, experimentExcluded: true, experimentExcludedSource: "auto" }),
      lap({ id: 8, lapTime: 90.6, experimentExcluded: true, experimentExcludedSource: "auto" }),
    ];

    const all = curateLaps(laps, OUTCOME_METRICS.consistencySpreadSec.curation);

    expect(all.kept.map((l) => l.id)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(all.reasonById.get(4)).toBe("manual");
    expect(all.droppedIneligible).toBe(1);
  });

  test("invalid and pit laps are ineligible under both policies", () => {
    const laps = [
      lap({ id: 1, lapTime: 90.0 }),
      lap({ id: 2, lapTime: 91.0, isValid: false }),
      lap({ id: 3, lapTime: 120.0, invalidReason: "inlap" }),
      lap({ id: 4, lapTime: 90.4 }),
    ];

    for (const curation of [FASTEST_5, OUTCOME_METRICS.consistencySpreadSec.curation]) {
      const pool = curateLaps(laps, curation);
      expect(pool.kept.map((l) => l.id)).toEqual([1, 4]);
      expect(pool.reasonById.get(2)).toBe("invalid");
      expect(pool.reasonById.get(3)).toBe("pit");
    }
  });
});

describe("blunder fence (the only outlier rule a variance pool gets)", () => {
  test("does not fire on a merely wide-but-real distribution", () => {
    const laps = stint([90.0, 90.4, 90.8, 91.2, 91.6, 92.0]);
    const pool = curateLaps(laps, OUTCOME_METRICS.consistencySpreadSec.curation);
    expect(pool.droppedOutliers).toBe(0);
    expect(pool.kept.length).toBe(6);
  });

  test("drops a spin lap and counts it as droppedOutliers", () => {
    const laps = stint([90.0, 90.1, 90.2, 90.15, 90.25, 104.0]);
    const pool = curateLaps(laps, OUTCOME_METRICS.consistencySpreadSec.curation);
    expect(pool.droppedOutliers).toBe(1);
    expect(pool.reasonById.get(6)).toBe("outlier");
    expect(pool.kept.length).toBe(5);
  });

  test("cannot fire under 4 samples, and never below best * 1.05", () => {
    expect(blunderFence([90, 90.5, 95])).toBeNull();
    const fence = blunderFence([90, 90, 90, 90]);
    expect(fence).toBe(90 * 1.05);
  });
});

describe("consistencySpreadSec extraction", () => {
  test("samples are absolute deviations from the arm's median lap time", () => {
    const laps = stint([89.0, 90.0, 91.0]).map((l) => ({ lap: l, telemetry: null }));
    const samples = extractSamples(OUTCOME_METRICS.consistencySpreadSec, { laps });
    expect(samples.map((s) => s.value)).toEqual([1, 0, 1]);
  });

  test("lapTimeSec samples are the raw lap times", () => {
    const laps = stint([89.0, 90.0]).map((l) => ({ lap: l, telemetry: null }));
    const samples = extractSamples(OUTCOME_METRICS.lapTimeSec, { laps });
    expect(samples).toEqual([
      { lapId: 1, value: 89.0 },
      { lapId: 2, value: 90.0 },
    ]);
  });

  test("frame-based metrics yield nothing without telemetry or corners", () => {
    const laps = stint([89.0, 90.0, 91.0]).map((l) => ({ lap: l, telemetry: null }));
    expect(extractSamples(OUTCOME_METRICS.inputVarianceBrake, { laps })).toEqual([]);
    expect(extractSamples(OUTCOME_METRICS.lineSpreadScore, { laps, corners: [] })).toEqual([]);
  });
});
