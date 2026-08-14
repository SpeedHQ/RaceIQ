import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { LapMeta } from "../../shared/racing/sessions/types";
import {
  ELIGIBILITY_POLICY_VERSION,
  type EligibilityDecision,
  type EligibilityDecisionSet,
  type EligibilityPolicyId,
} from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize } from "../../test/support/lap-analysis/quality-model";
import { TrackFocusViewInner, trackFocusLapPools } from "../src/components/tunes/track-focus/TrackFocusView";
import { stintStats } from "../src/lib/stint-traces";

const quality = summarize(qualityPackets(200), {
  classification: {
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
  },
});

function decision(policyId: EligibilityPolicyId, status: EligibilityDecision["status"] = "eligible"): EligibilityDecision {
  return {
    policyId,
    policyVersion: ELIGIBILITY_POLICY_VERSION,
    status,
    confidence: { level: "high", score: 1 },
    reasons: [],
    evidenceIds: [],
  };
}

function eligibility(normalStatus: EligibilityDecision["status"] = "eligible"): EligibilityDecisionSet {
  return {
    "normal-pace": decision("normal-pace", normalStatus),
    "corner-trace": decision("corner-trace"),
    "setup-analysis": decision("setup-analysis"),
  } as EligibilityDecisionSet;
}

function lap(id: number, lapTime: number, overrides: Partial<LapMeta> = {}): LapMeta {
  return {
    id,
    sessionId: 1,
    lapNumber: id,
    lapTime,
    isValid: true,
    invalidReason: null,
    phase: "flying",
    conditions: [],
    paceEligibility: "eligible",
    quality,
    eligibility: eligibility(),
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as LapMeta;
}

function renderCaption(laps: LapMeta[]): string {
  const pools = trackFocusLapPools(laps);
  return renderToStaticMarkup(
    <TrackFocusViewInner
      laps={pools.eligibleLaps}
      traces={[]}
      bestLapId={pools.traceLaps[0]?.id ?? null}
      focusLapId={pools.traceLaps[0]?.id ?? null}
      onFocusLap={() => {}}
      focusTelemetry={null}
      focusSectorTimes={null}
      edges={null}
      corners={[]}
      issues={[]}
      stats={stintStats(pools.statisticsLaps)}
      lineSpread={null}
      shownLapCount={pools.traceLaps.length}
      totalLapCount={pools.eligibleLaps.length}
    />,
  );
}

describe("Track Focus lap pools", () => {
  test("caps frame-heavy traces while keeping every eligible lap for stint statistics", () => {
    const laps = [lap(1, 97, { experimentExcluded: true, experimentExcludedSource: "auto" }), lap(2, 91), lap(3, 94), lap(4, 92), lap(5, 96), lap(6, 93), lap(7, 95)];
    const pools = trackFocusLapPools(laps);

    expect(pools.traceLaps.map(({ id }) => id)).toEqual([2, 3, 4, 6, 7]);
    expect(pools.eligibleLaps.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(stintStats(pools.statisticsLaps).n).toBe(7);
    expect(renderCaption(laps)).toContain("Trace views show the 5 fastest of 7 eligible laps. Statistics use all 7.");
  });

  test("keeps manual and policy-excluded laps out of both pools and caption total", () => {
    const laps = [
      lap(1, 91),
      lap(2, 92),
      lap(3, 93),
      lap(4, 94),
      lap(5, 95),
      lap(6, 96),
      lap(7, 80, { experimentExcluded: true, experimentExcludedSource: "manual" }),
      lap(8, 81, { eligibility: eligibility("ineligible") }),
    ];
    const pools = trackFocusLapPools(laps);

    expect(pools.traceLaps.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
    expect(pools.eligibleLaps.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pools.statisticsLaps.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(stintStats(pools.statisticsLaps).n).toBe(6);
    expect(renderCaption(laps)).toContain("Trace views show the 5 fastest of 6 eligible laps. Statistics use all 6.");
  });
});
