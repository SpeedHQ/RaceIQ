import type { Meta, StoryObj } from "@storybook/react";
import type { DriverFingerprint, RankedWeakness, StyleAxes } from "../../../server/ai/driver-profile-aggregate";
import type { DriverProfileOutput } from "../../../server/ai/schemas";
import type { DriverProfileRun } from "../hooks/queries";
import { DriverProgressCard } from "../components/HomePage";
import { DriverProfileView } from "../components/driver/DriverProfileView";

/**
 * Fixed, deterministic fixtures. The states worth looking at are the awkward
 * ones — a fingerprint with no plan yet, axes that came back null, faults with
 * no measured cost, a driver past the grip limit — because those are the ones a
 * live fetch only produces by luck.
 */

function weakness(over: Partial<RankedWeakness> = {}): RankedWeakness {
  return {
    id: "driving-early-braking",
    category: "driving",
    label: "Early braking",
    perLapFrequency: 0.82,
    lapsAffected: 18,
    meanSeverityWeight: 2,
    peakSeverity: "warning",
    medianTimeLossS: 0.28,
    lapsQuantified: 18,
    sampleDetail: "Braked 34 m before the 100 board into T5 on 18 of 22 laps",
    score: 0.153,
    timeLossKnown: true,
    ...over,
  };
}

const WEAKNESSES: RankedWeakness[] = [
  weakness(),
  weakness({
    id: "driving-over-slowing",
    label: "Over-slowing at apex",
    perLapFrequency: 0.64,
    lapsAffected: 14,
    medianTimeLossS: 0.19,
    lapsQuantified: 14,
    sampleDetail: "Minimum speed 7 km/h below the session best through T9",
    score: 0.081,
  }),
  weakness({
    id: "driving-throttle-micro-lifts",
    label: "Throttle micro-lifts on exit",
    perLapFrequency: 0.45,
    lapsAffected: 10,
    meanSeverityWeight: 1,
    peakSeverity: "info",
    medianTimeLossS: 0.07,
    lapsQuantified: 9,
    sampleDetail: "Three lifts between T12 exit and the back straight",
    score: 0.011,
  }),
];

const UNQUANTIFIED: RankedWeakness[] = [
  weakness({
    id: "driving-coasting",
    label: "Coasting between brake and throttle",
    perLapFrequency: 0.73,
    lapsAffected: 16,
    medianTimeLossS: null,
    lapsQuantified: 0,
    timeLossKnown: false,
    peakSeverity: "warning",
    sampleDetail: "0.4 s with neither pedal applied approaching T3",
    score: 0.487,
  }),
  weakness({
    id: "tire-temp-front-low",
    label: "Front tyres below working range",
    perLapFrequency: 0.5,
    lapsAffected: 11,
    medianTimeLossS: null,
    lapsQuantified: 0,
    timeLossKnown: false,
    meanSeverityWeight: 1,
    peakSeverity: "info",
    sampleDetail: "Front-left peaked at 71 °C against a 85–95 °C window",
    score: 0.167,
  }),
];

const STYLE: StyleAxes = {
  gripUtilMedian: 0.74,
  gripUtilP95: 1.02,
  balanceMedianDeg: 2.4,
  understeerFraction: 0.41,
  oversteerFraction: 0.08,
  controlLossFraction: 0.021,
  steerReversalsPerS: 1.6,
  slipVariabilityDeg: 1.1,
  brakingStyle: -52,
  consistency: 86,
  physicsLaps: 22,
};

const FINGERPRINT: DriverFingerprint = {
  ok: true,
  scope: { kind: "car-track", gameId: "fm-2023", carOrdinal: 2860, trackOrdinal: 7 },
  laps: { lapIds: [], analyzed: 22, candidates: 31, droppedInvalid: 5, droppedOutlier: 4, droppedByCap: 0, droppedNoTelemetry: 0 },
  confidence: "high",
  style: STYLE,
  pace: { consistency: 86, sdS: 0.34, bestS: 137.421, meanS: 138.06, degSlopeSPerLap: 0.021, n: 22, basis: "single-context", contexts: 1 },
  weaknesses: WEAKNESSES,
  unquantifiedWeaknesses: UNQUANTIFIED,
  strengths: [
    { id: "tire-lockup-front", label: "Front lockups", perLapFrequency: 0, basis: "absent" },
    { id: "driving-late-braking-overshoot", label: "Overshooting the apex", perLapFrequency: 0, basis: "absent" },
    { id: "driving-wheelspin-exit", label: "Wheelspin on exit", perLapFrequency: 0.09, basis: "rare" },
  ],
  detectors: [...WEAKNESSES, ...UNQUANTIFIED],
  notes: ["5 invalid laps and 4 outliers excluded from the pool."],
};

const PLAN: DriverProfileOutput = {
  summary:
    "You commit properly once the car is turned — your peak grip use touches the limit and you almost never lose the rear. What's costing you is the approach: you arrive at the brake pedal early, then spend the entry waiting. Fix the brake point and most of the rest follows.",
  styleLabel: "committed mid-corner, tentative on entry",
  strengths: [
    { title: "You keep the car placed", detail: "Only 2% of your cornering frames show the rear stepping out — rotation looks deliberate rather than caught." },
    { title: "Steady hands", detail: "1.6 steering reversals per second is settled; you're not correcting your way through corners." },
  ],
  focusAreas: [
    {
      detectorId: "driving-early-braking",
      title: "Move the brake point later into slow corners",
      whatHappens: "You reach for the pedal around 34 m before the 100 board into T5, and did so on 18 of 22 laps. It's consistent, which means it's a habit rather than a mistake.",
      whyItCosts:
        "Braking that early means you finish slowing before the corner needs you to, so you carry a closed throttle through a stretch where the car would still take speed. The time goes on the entry, not in the corner.",
      drill:
        "Pick the 100 board and move your brake point one car length later each lap until you miss the apex. Step back one and hold it for five laps. You'll know it's working when you're still trailing the brake at turn-in rather than coasting to it.",
      estimatedGainS: 0.28,
    },
    {
      detectorId: "driving-over-slowing",
      title: "Stop scrubbing the last 7 km/h at the apex",
      whatHappens: "Your minimum speed through T9 sits about 7 km/h under what you've managed in the same session, on roughly two thirds of laps.",
      whyItCosts: "Speed given up at the apex has to be rebuilt down the whole following straight, so a small loss at the slowest point of the corner is paid back over the longest part of the lap.",
      drill:
        "Run five laps deliberately trying to carry too much speed into T9 and accept running wide. Then back off until you just make the exit — the right minimum speed is usually just under where you first ran out of road.",
      estimatedGainS: 0.19,
    },
    {
      detectorId: "driving-coasting",
      title: "Close the gap between brake and throttle",
      whatHappens: "There's about 0.4 s approaching T3 where neither pedal is doing anything.",
      whyItCosts:
        "The car is neither slowing nor accelerating, so that time buys you nothing. It usually appears when the brake point is early: you've finished braking and are waiting for the corner to arrive.",
      drill:
        "Have someone watch your pedal trace, or check it afterwards — the brake release and throttle pickup should overlap. If there's a flat gap, your brake point is the real problem, not your throttle.",
    },
  ],
  sessionPlan: [
    "Ten laps working only on the T5 brake point. Ignore your lap time.",
    "Five laps deliberately over-committing into T9 to find where the limit actually is.",
    "Ten normal laps, then check whether the coasting gap before T3 has closed.",
  ],
};

const RUN_HISTORY: DriverProfileRun[] = [
  {
    id: 42,
    scopeKey: "fm-2023|2860|7",
    gameId: "fm-2023",
    carOrdinal: 2860,
    trackOrdinal: 7,
    poolKey: "pool-20260729",
    status: "succeeded",
    fingerprint: JSON.stringify(FINGERPRINT),
    plan: JSON.stringify(PLAN),
    error: null,
    inputTokens: 4280,
    outputTokens: 910,
    costUsd: 0.021,
    durationMs: 8400,
    model: "gemini-3-flash",
    createdAt: "2026-07-29T13:58:00.000Z",
    startedAt: "2026-07-29T13:58:01.000Z",
    completedAt: "2026-07-29T13:58:09.000Z",
  },
  {
    id: 41,
    scopeKey: "fm-2023|2860|7",
    gameId: "fm-2023",
    carOrdinal: 2860,
    trackOrdinal: 7,
    poolKey: "pool-20260728",
    status: "failed",
    fingerprint: null,
    plan: null,
    error: "Provider timeout after 30 seconds.",
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 30000,
    model: "gemini-3-flash",
    createdAt: "2026-07-28T18:20:00.000Z",
    startedAt: "2026-07-28T18:20:01.000Z",
    completedAt: "2026-07-28T18:20:31.000Z",
  },
];

const meta = {
  title: "Driver/Profile",
  component: DriverProfileView,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-5">
          <h1 className="text-lg font-semibold text-app-text">Driver Profile</h1>
          <p className="text-sm text-app-text-muted">How you drive, and what to work on next.</p>
        </header>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DriverProfileView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The full thing: measurements plus a generated plan. */
export const Full: Story = {
  args: { fingerprint: FINGERPRINT, plan: PLAN, cached: false },
};

/** Automatic coaching enabled with a successful latest run and auditable history. */
export const AutomaticCoaching: Story = {
  args: {
    fingerprint: FINGERPRINT,
    plan: PLAN,
    cached: true,
    runState: "succeeded",
    latestRun: RUN_HISTORY[0],
    runHistory: RUN_HISTORY,
    onRunNow: () => undefined,
    onRetry: () => undefined,
  },
};

/**
 * What you see after building the profile but before running the coach. The
 * measured column stands on its own — that's the point of splitting them.
 */
export const MeasuredOnly: Story = {
  args: { fingerprint: FINGERPRINT, plan: null },
};

/** The compact deterministic snapshot shown on an active game's home page. */
export const ProgressSummary: Story = {
  render: () => <DriverProgressCard gameId="fm-2023" fingerprint={FINGERPRINT} medianLapSec={138.01} />,
};

/** Empty state with a direct route to record/analyse the first laps. */
export const ProgressEmpty: Story = {
  render: () => (
    <DriverProgressCard
      gameId="fm-2023"
      fingerprint={{ ...FINGERPRINT, ok: false, laps: { ...FINGERPRINT.laps, analyzed: 0 }, pace: { ...FINGERPRINT.pace, bestS: null, meanS: null, consistency: null, n: 0 } }}
    />
  ),
};
/** Deterministic measurements stay visible while an AI coach is running. */
export const CoachRunning: Story = {
  args: { fingerprint: FINGERPRINT, plan: null, coachStatus: "running" },
};

/** A failed coach run does not erase or replace measured data. */
export const CoachFailure: Story = {
  args: { fingerprint: FINGERPRINT, plan: null, coachStatus: "error", coachError: "No AI provider selected." },
};

/**
 * A driver working past the tyres' limit. Grip median above 1.0 is scrubbing,
 * not commitment, so the gauge reads red rather than rewarding the higher
 * number — the failure mode a "higher is better" scale would have hidden.
 */
export const PastTheLimit: Story = {
  args: {
    fingerprint: {
      ...FINGERPRINT,
      style: {
        ...STYLE,
        gripUtilMedian: 1.12,
        gripUtilP95: 1.38,
        balanceMedianDeg: -5.4,
        controlLossFraction: 0.14,
        steerReversalsPerS: 3.8,
        slipVariabilityDeg: 2.9,
        brakingStyle: 44,
        consistency: 61,
      },
    },
    plan: null,
  },
};

/**
 * Axes that could not be measured. They render as an explicit "not measured"
 * row rather than a zero-length bar — absent is not the same as zero, and a
 * radar chart would have had no way to say so.
 */
export const PartiallyMeasurable: Story = {
  args: {
    fingerprint: {
      ...FINGERPRINT,
      confidence: "low",
      laps: { ...FINGERPRINT.laps, analyzed: 4, candidates: 6 },
      style: { ...STYLE, gripUtilMedian: null, gripUtilP95: null, controlLossFraction: null, slipVariabilityDeg: null, consistency: null, physicsLaps: 2 },
      notes: ["Only 4 laps had usable telemetry.", "2 laps dropped: no cornering frames above the lateral-g floor."],
    },
    plan: null,
  },
};

/**
 * Every recurring fault is one the aggregator could not cost. The ranked list
 * is empty and the plan's focus areas carry no seconds badge — deliberately
 * blank rather than "0.00s", which would read as "this one is free".
 */
export const NothingQuantified: Story = {
  args: {
    fingerprint: { ...FINGERPRINT, weaknesses: [], unquantifiedWeaknesses: UNQUANTIFIED, detectors: UNQUANTIFIED },
    plan: {
      ...PLAN,
      summary: "Nothing you do repeatedly could be costed in seconds, so this plan is ordered by how often each habit shows up and how bad it looks rather than by time.",
      focusAreas: [
        {
          detectorId: "driving-coasting",
          title: "Close the gap between brake and throttle",
          whatHappens: "There's about 0.4 s approaching T3 where neither pedal is doing anything.",
          whyItCosts: "The car is neither slowing nor accelerating. The cost is real but it overlaps with your braking, so it can't be separated out cleanly.",
          drill: "Check your pedal trace: brake release and throttle pickup should overlap rather than leaving a flat gap.",
        },
        {
          detectorId: "tire-temp-front-low",
          title: "Get temperature into the front tyres",
          whatHappens: "Your front-left peaks around 71 °C against a working window of 85–95 °C.",
          whyItCosts: "Cold fronts give less grip than the tyre can produce, which shows up as understeer you then drive around instead of fixing.",
          drill: "Weave harder on the out-lap and load the fronts early. Check whether your first flying lap still understeers on entry.",
        },
      ],
    },
  },
};

/**
 * Global scope — the pool spans cars and tracks, so seconds-valued pace stats
 * are withheld upstream and only the unitless numbers survive.
 */
export const GlobalScope: Story = {
  args: {
    fingerprint: {
      ...FINGERPRINT,
      scope: { kind: "global", gameId: "fm-2023", carOrdinal: null, trackOrdinal: null },
      laps: { ...FINGERPRINT.laps, analyzed: 40, candidates: 214, droppedByCap: 160 },
      pace: { consistency: 79, sdS: null, bestS: null, meanS: null, degSlopeSPerLap: null, n: 40, basis: "median-of-contexts", contexts: 11 },
      notes: ["Pool spans 11 car/track combinations — lap-time statistics are not comparable across them.", "Capped at 40 laps; 160 older laps not analysed."],
    },
    plan: PLAN,
    cached: true,
    warnings: ["Ignored 1 focus area citing a fault not in the profile."],
  },
};
