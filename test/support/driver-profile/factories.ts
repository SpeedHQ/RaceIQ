import type { ProfileScope } from "../../../server/driver-profile/fingerprint";
import type { LapStyleSummary } from "../../../shared/racing/analysis/laps/driving-style";
import type { LapInsight } from "../../../shared/racing/analysis/laps/insights/types";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import type { EligibilityDecisionSet } from "../../../shared/racing/quality/contracts";

export const SCOPE: ProfileScope = { kind: "car-track", gameId: "fm-2023", carOrdinal: 100, trackOrdinal: 200 };
export const GLOBAL_SCOPE: ProfileScope = { kind: "global", gameId: "fm-2023", carOrdinal: null, trackOrdinal: null };

export function lap(id: number, over: Partial<LapMeta> = {}): LapMeta {
  const value: LapMeta = {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime: 90 + (id % 5) * 0.1,
    isValid: true,
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
    createdAt: "2026-01-01T00:00:00.000Z",
    gameId: "fm-2023",
    carOrdinal: 100,
    trackOrdinal: 200,
    ...over,
  };
  if (over.eligibility) return value;
  const usable = value.isValid && value.paceEligibility === "eligible";
  return {
    ...value,
    eligibility: {
      "normal-pace": {
        status: usable ? "eligible" : "ineligible",
        policyId: "normal-pace",
        policyVersion: "1",
        confidence: { level: "high", score: 1 },
        reasons: usable ? [] : [{ code: "structurally_invalid", severity: "error", evidenceIds: [`lap:${id}:validity`], timeRange: null, distanceRange: null, semanticIds: [] }],
        evidenceIds: usable ? [] : [`lap:${id}:validity`],
      },
    } as unknown as EligibilityDecisionSet,
  };
}

export function insight(id: string, over: Partial<LapInsight> = {}): LapInsight {
  return {
    id,
    category: "driving",
    severity: "warning",
    label: id,
    detail: `${id} detail`,
    frameIndices: [10],
    ...over,
  };
}

/**
 * A per-lap physics summary. Synthesised directly rather than run through
 * `summariseLapStyle` — that function has its own test file; here we only care
 * that the aggregator medians them honestly.
 */
export function styleLap(over: Partial<LapStyleSummary> = {}): LapStyleSummary {
  return {
    frames: 3600,
    corneringFrames: 1200,
    corneringSeconds: 20,
    usable: true,
    gripUtilMedian: 0.7,
    gripUtilP95: 1.05,
    balanceMedianDeg: 1.2,
    understeerFraction: 0.18,
    oversteerFraction: 0.04,
    controlLossFraction: 0.01,
    steerReversalsPerS: 1.1,
    slipVariabilityDeg: 0.9,
    ...over,
  };
}

export function unusableLap(): LapStyleSummary {
  return { frames: 500, corneringFrames: 4, corneringSeconds: 0.07, usable: false };
}

/** N laps that all exhibit the same set of insights. */
export function habitualDriver(n: number, insights: LapInsight[]) {
  return {
    laps: Array.from({ length: n }, (_, i) => lap(i + 1)),
    perLapInsights: Array.from({ length: n }, () => insights.map((x) => ({ ...x }))),
  };
}
