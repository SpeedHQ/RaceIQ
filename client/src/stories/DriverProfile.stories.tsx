import type { Meta, StoryObj } from "@storybook/react";
import type { DriverProfileSummary } from "../../../server/ai/schemas";
import type { RankedWeakness, StyleAxes } from "../../../server/driver-profile/detectors";
import type { DriverFingerprint } from "../../../server/driver-profile/fingerprint";
import type { DriverTrend, DriverTrendLap, DriverTrendWindow } from "../../../server/driver-profile/trend";
import { DriverProfileView } from "../components/driver/DriverProfileView";
import type { DriverProfileRun, DriverProfileState } from "../hooks/queries";
import { Button } from "../components/ui/button";

const GAME_ID = "fm-2023" as const;

function lap(id: number, valid: boolean, pace: number | null, day = 29): DriverTrendLap {
  return { id, createdAt: `2026-07-${String(day).padStart(2, "0")}T12:${String(id % 60).padStart(2, "0")}:00.000Z`, isValid: valid, relativePacePct: pace };
}

function windowOf(laps: DriverTrendLap[], contexts = 1): DriverTrendWindow {
  const comparable = laps.flatMap((item) => (item.relativePacePct === null ? [] : [item.relativePacePct]));
  const median = comparable.length ? comparable.slice().sort((a, b) => a - b)[Math.floor(comparable.length / 2)] : null;
  const spread = comparable.length > 1 ? Math.max(...comparable) - Math.min(...comparable) : null;
  const valid = laps.filter((item) => item.isValid).length;
  return {
    laps,
    total: laps.length,
    valid,
    dirty: laps.length - valid,
    cleanRate: laps.length ? valid / laps.length : null,
    normalized: comparable.length,
    consistency: comparable.length > 1 ? 91 : null,
    medianPacePct: median,
    spreadPct: spread,
    contexts,
  };
}

function trend(recent: DriverTrendWindow, previous: DriverTrendWindow, overrides: Partial<DriverTrend> = {}): DriverTrend {
  return {
    recent,
    previous,
    consistencyDelta: recent.consistency === null || previous.consistency === null ? null : recent.consistency - previous.consistency,
    paceDeltaPct: recent.medianPacePct === null || previous.medianPacePct === null ? null : recent.medianPacePct - previous.medianPacePct,
    spreadDeltaPct: recent.spreadPct === null || previous.spreadPct === null ? null : recent.spreadPct - previous.spreadPct,
    cleanRateDelta: recent.cleanRate === null || previous.cleanRate === null ? null : recent.cleanRate - previous.cleanRate,
    consistencyDirection: "improving",
    paceDirection: "improving",
    validityDirection: "improving",
    advice: [{ id: "keep-approach", tone: "positive", title: "Keep this approach", detail: "Recent comparable laps are trending in the right direction." }],
    ...overrides,
  };
}

const STYLE: StyleAxes = {
  gripUtilMedian: 0.78,
  gripUtilP95: 0.98,
  balanceMedianDeg: 1.8,
  understeerFraction: 0.21,
  oversteerFraction: 0.08,
  controlLossFraction: 0.01,
  steerReversalsPerS: 1.1,
  slipVariabilityDeg: 0.9,
  brakingStyle: -24,
  consistency: 86,
  physicsLaps: 30,
};
const weakness: RankedWeakness = {
  id: "driving-early-braking",
  category: "driving",
  label: "Early braking",
  perLapFrequency: 0.42,
  lapsAffected: 5,
  meanSeverityWeight: 1.4,
  peakSeverity: "warning",
  medianTimeLossS: 0.18,
  lapsQuantified: 5,
  sampleDetail: "Brake point arrives early into the hairpin.",
  score: 0.08,
  timeLossKnown: true,
};
const recent30 = Array.from({ length: 30 }, (_, index) => lap(index + 1, index !== 4 && index !== 17, 1.8 - index * 0.035, 29));
const previous30 = Array.from({ length: 30 }, (_, index) => lap(index + 101, true, 2.8 - index * 0.01, 28));
const BASE_TREND = trend(windowOf(recent30), windowOf(previous30), { paceDeltaPct: -1.2, spreadDeltaPct: -0.8, cleanRateDelta: 0.06 });

const FINGERPRINT: DriverFingerprint = {
  ok: true,
  scope: { kind: "global", gameId: GAME_ID, carOrdinal: null, trackOrdinal: null },
  laps: { lapIds: recent30.map((item) => item.id), analyzed: 30, candidates: 34, droppedNoTelemetry: 2 },
  confidence: "high",
  style: STYLE,
  trend: BASE_TREND,
  weaknesses: [weakness],
  unquantifiedWeaknesses: [],
  detectors: [weakness],
  notes: ["Two dirty laps excluded from clean-rate calculations."],
};
const SUMMARY: DriverProfileSummary = {
  headline: "Your pace is becoming more repeatable",
  summary: "The recent window is faster and tighter than the previous baseline, with enough clean laps to make the direction credible.",
};
const RUN: DriverProfileRun = {
  id: 42,
  scopeKey: `${GAME_ID}:global`,
  gameId: GAME_ID,
  carOrdinal: null,
  trackOrdinal: null,
  poolKey: `${GAME_ID}:global`,
  status: "succeeded",
  fingerprint: JSON.stringify(FINGERPRINT),
  plan: JSON.stringify(SUMMARY),
  error: null,
  inputTokens: 4280,
  outputTokens: 910,
  costUsd: 0.021,
  durationMs: 8400,
  model: "storybook-fixture",
  createdAt: "2026-07-29T13:58:00.000Z",
  startedAt: "2026-07-29T13:58:01.000Z",
  completedAt: "2026-07-29T13:58:09.000Z",
};

function fixture(overrides: Partial<DriverFingerprint> = {}): DriverFingerprint {
  return { ...FINGERPRINT, ...overrides };
}
function stateArgs(runState: DriverProfileState, summary: DriverProfileSummary | null = null, withRefresh = true) {
  return {
    fingerprint: FINGERPRINT,
    plan: summary,
    runState,
    latestRun: runState === "succeeded" ? RUN : null,
    ...(withRefresh ? { onRefresh: () => undefined } : {}),
    runPending: runState === "queued" || runState === "running",
  };
}

const meta = {
  title: "Driver/Profile",
  component: DriverProfileView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold text-app-text">Driver Profile</h1>
            <p className="text-sm text-app-text-muted">How your driving is changing</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" className="rounded-md border border-app-border bg-app-surface px-3 py-2 text-xs text-app-text">
              All Forza Motorsport laps
            </Button>
            <Button type="button" className="rounded-md bg-app-accent px-3 py-2 text-xs font-medium text-app-on-filled hover:bg-app-accent-hover">
              Refresh AI summary
            </Button>
          </div>
        </header>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DriverProfileView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Full30ImprovingDirtyLaps: Story = { args: { fingerprint: FINGERPRINT, plan: SUMMARY, runState: "succeeded", latestRun: RUN, runHistory: [RUN] } };
export const FewerThan30RecentLaps: Story = {
  args: {
    fingerprint: fixture({
      trend: trend(windowOf([lap(1, true, 1.5), lap(2, false, 2.1), lap(3, true, 1.8)]), windowOf([lap(11, true, 2.4), lap(12, true, 2.2)]), {
        advice: [{ id: "build-baseline", tone: "neutral", title: "Build a comparable baseline", detail: "Only a few recent laps are available." }],
      }),
    }),
    plan: null,
  },
};
export const NoPreviousBaseline: Story = {
  args: {
    fingerprint: fixture({
      trend: trend(windowOf(recent30), windowOf([]), {
        consistencyDirection: "unavailable",
        paceDirection: "unavailable",
        validityDirection: "unavailable",
        consistencyDelta: null,
        paceDeltaPct: null,
        spreadDeltaPct: null,
        cleanRateDelta: null,
        advice: [{ id: "build-baseline", tone: "neutral", title: "Build a baseline", detail: "Previous comparable laps are not available yet." }],
      }),
    }),
    plan: null,
  },
};
export const MixedContexts: Story = {
  args: {
    fingerprint: fixture({
      trend: trend(windowOf(recent30, 3), windowOf(previous30, 3), {
        advice: [{ id: "hold-steady", tone: "neutral", title: "Hold steady across contexts", detail: "Recent laps span three comparable car and track contexts." }],
      }),
    }),
    plan: null,
  },
};
export const AllDirty: Story = {
  args: {
    fingerprint: fixture({
      trend: trend(windowOf(recent30.map((item) => ({ ...item, isValid: false }))), windowOf(previous30), {
        validityDirection: "declining",
        advice: [{ id: "protect-validity", tone: "caution", title: "Protect lap validity", detail: "Every recent lap is dirty, so pace comparisons need caution." }],
      }),
    }),
    plan: null,
  },
};
export const MissingBenchmarkAndNormalizedPace: Story = {
  args: {
    fingerprint: fixture({
      trend: trend(windowOf(recent30.map((item) => ({ ...item, relativePacePct: null }))), windowOf(previous30.map((item) => ({ ...item, relativePacePct: null }))), {
        paceDirection: "unavailable",
        consistencyDirection: "unavailable",
        advice: [{ id: "reset-baseline", tone: "caution", title: "Reset the comparison baseline", detail: "Comparable normalized pace is unavailable for these laps." }],
      }),
      style: { ...STYLE, consistency: null, physicsLaps: 0 },
      notes: ["No valid benchmark or normalized pace was available."],
    }),
    plan: null,
  },
};
export const AISummaryLoading: Story = { args: { ...stateArgs("running") } };
export const AISummarySuccess: Story = { args: { ...stateArgs("succeeded", SUMMARY) } };
export const AISummaryFailure: Story = { args: { ...stateArgs("failed"), latestRun: { ...RUN, status: "failed", plan: null, fingerprint: null, error: "Provider request failed." } } };
export const BackgroundDisabledManualEnabled: Story = { args: { ...stateArgs("disabled") } };
export const ProviderNotConfigured: Story = { args: { ...stateArgs("not-configured", null, false) } };
