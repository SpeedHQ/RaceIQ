import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ExperimentList } from "../components/tunes/ExperimentList";
import { ExperimentWorkspace } from "../components/tunes/ExperimentWorkspace";
import { TestReviewPage } from "../components/tunes/TestReviewPage";
import type { Experiment, ExperimentLapMetric, ExperimentVersion } from "../hooks/queries";

/**
 * The experiment flow end to end — list → workspace → review — in both
 * variants: a SETUP experiment (arms are setup versions) and a DRIVING
 * experiment (arms are drills, no setup file).
 *
 * ⚠️ Read the driving stories as a spec with a caveat. The screens render real
 * components against real data shapes, and a drill's `appliedChanges` renders
 * today because `shared/test-changes.ts` already parses the `SetupChange |
 * DrillChange` union. What does NOT exist yet (issue #120 Phase 3) is any way
 * to *create* one: `experiments` has no `kind` column, so there is no variant
 * badge on the list, no Setup/Driving choice at creation, and no drill-arm
 * form. Every driving story below is therefore hand-seeded, and the gaps it
 * exposes are the Phase 3 worklist rather than bugs:
 *
 *   - the list cannot say which variant a row is
 *   - the workspace offers "Save & recommend" (a setup action) on both
 *   - the review dashboard has no outcome-metric selector, so a driving
 *     experiment is still judged by lap time rather than by variance
 *
 * Keeping them here means the Phase 3 UI gets built against a picture of where
 * it lands, and the day `kind` exists these stories start telling the truth.
 */

const SETUP_ID = 42;
const DRIVING_ID = 43;

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function experiment(over: Partial<Experiment> & { id: number }): Experiment {
  return {
    seq: 1,
    gameId: "acc",
    name: "",
    carOrdinal: null,
    trackOrdinal: null,
    carName: "Huracan GT3",
    trackName: "Spa-Francorchamps",
    baseSetupPath: null,
    status: "active",
    notes: null,
    createdAt: ago(86_400_000),
    updatedAt: ago(3_600_000),
    ...over,
  } as Experiment;
}

function version(over: Partial<ExperimentVersion> & { id: number; experimentId: number; version: number; label: string }): ExperimentVersion {
  return {
    setupPath: null,
    parentVersionId: null,
    appliedChanges: null,
    driverComment: null,
    notes: null,
    engine: null,
    setupSnapshot: null,
    status: "active",
    createdAt: ago(3_600_000),
    lapCount: 0,
    bestLapMs: null,
    ...over,
  } as ExperimentVersion;
}

/** A stint of laps against one version. `spread` widens the lap-time scatter,
 *  which is the whole signal a driving experiment is measuring. */
function stint(opts: {
  startId: number;
  experimentId: number;
  versionId: number;
  count: number;
  base: number;
  spread: number;
  startedMsAgo: number;
}) {
  const { startId, experimentId, versionId, count, base, spread, startedMsAgo } = opts;
  return Array.from({ length: count }, (_, i) => {
    // Deterministic pseudo-scatter — stories must not change between reloads.
    const jitter = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
    return {
      id: startId + i,
      sessionId: 1,
      lapNumber: i + 1,
      lapTime: +(base + jitter * spread).toFixed(3),
      isValid: true,
      invalidReason: null,
      experimentId,
      experimentVersionId: versionId,
      experimentExcluded: false,
      experimentExcludedSource: null,
      createdAt: ago(startedMsAgo - i * 100_000),
      carOrdinal: 42,
      trackOrdinal: 7,
      s1Time: 30.1,
      s2Time: 33.5,
      s3Time: 30.6,
    };
  });
}

// ── Setup variant ───────────────────────────────────────────────────────────
// Two arms, a real applied change between them, and the driver's verdict.

const setupExperiment = experiment({
  id: SETUP_ID,
  seq: 7,
  name: "Spa — rear stability on entry",
  baseSetupPath: "C:/setups/spa_race_dry.json",
});

const setupVersions: ExperimentVersion[] = [
  version({
    id: 100,
    experimentId: SETUP_ID,
    version: 1,
    label: "Base setup",
    setupPath: "C:/setups/spa_race_dry.json",
    createdAt: ago(7_200_000),
    lapCount: 8,
    bestLapMs: 138_420,
  }),
  version({
    id: 101,
    experimentId: SETUP_ID,
    version: 2,
    label: "Softer rear ARB",
    setupPath: "C:/setups/spa_race_dry_v2.json",
    parentVersionId: 100,
    appliedChanges: JSON.stringify([
      {
        kind: "setup",
        component: "Rear anti-roll bar",
        paths: ["mechanicalBalance.aRBRear"],
        from: 5,
        to: 3,
        direction: "decrease",
        reason: "Free the rear on entry so it rotates before the front washes out",
      },
    ]),
    driverComment: "Rotates earlier, no snap. Happier.",
    notes: "Expect entry gain in T1/Les Combes, small loss on exit traction.",
    engine: "autotune",
    createdAt: ago(3_600_000),
    lapCount: 9,
    bestLapMs: 137_980,
  }),
];

const setupLaps = [
  ...stint({ startId: 1000, experimentId: SETUP_ID, versionId: 100, count: 8, base: 138.4, spread: 0.55, startedMsAgo: 7_000_000 }),
  ...stint({ startId: 1100, experimentId: SETUP_ID, versionId: 101, count: 9, base: 137.98, spread: 0.5, startedMsAgo: 3_400_000 }),
];

// ── Driving variant ─────────────────────────────────────────────────────────
// Same machinery, arms are drills. No setupPath anywhere — that is the point:
// the schema already allows a version with no setup file behind it.
//
// The lap times barely move between arms while the SPREAD halves, which is
// exactly the case lap time cannot express and `consistencySpreadSec` can.

const drivingExperiment = experiment({
  id: DRIVING_ID,
  seq: 8,
  name: "Spa — brake-release consistency",
  carName: "Huracan GT3",
});

const drivingVersions: ExperimentVersion[] = [
  version({
    id: 200,
    experimentId: DRIVING_ID,
    version: 1,
    label: "Baseline — drive normally",
    createdAt: ago(7_200_000),
    lapCount: 10,
    bestLapMs: 138_600,
  }),
  version({
    id: 201,
    experimentId: DRIVING_ID,
    version: 2,
    label: "Trail-brake to the apex at Les Combes",
    parentVersionId: 200,
    appliedChanges: JSON.stringify([
      {
        kind: "drill",
        title: "Trail-brake to the apex at Les Combes",
        instruction:
          "Carry 10 bar of brake pressure past turn-in and release it progressively to zero at the apex, instead of releasing everything before you turn.",
        corners: ["T5 Les Combes"],
        reason: "Brake release point varies by 18m lap to lap here — the least repeatable corner on the lap.",
      },
    ]),
    driverComment: "Felt slower but the car placed the same every lap.",
    notes: "Predicted: brake-release scatter halves. Lap time unchanged — that is not the outcome being tested.",
    createdAt: ago(3_600_000),
    lapCount: 11,
    bestLapMs: 138_540,
  }),
];

const drivingLaps = [
  ...stint({ startId: 2000, experimentId: DRIVING_ID, versionId: 200, count: 10, base: 138.6, spread: 1.4, startedMsAgo: 7_000_000 }),
  ...stint({ startId: 2100, experimentId: DRIVING_ID, versionId: 201, count: 11, base: 138.54, spread: 0.6, startedMsAgo: 3_400_000 }),
];

const allLaps = [...setupLaps, ...drivingLaps];

const lapMetrics = (laps: typeof allLaps): ExperimentLapMetric[] =>
  laps.map((l, i) => ({
    lapId: l.id,
    fuelPerLap: +(2.7 + Math.sin(i / 3) * 0.25).toFixed(2),
    tyreWear: +(3 + i * 1.2).toFixed(1),
  }));

function seededClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["experiments", "acc"], [setupExperiment, drivingExperiment]);
  qc.setQueryData(["experiment", SETUP_ID], setupExperiment);
  qc.setQueryData(["experiment", DRIVING_ID], drivingExperiment);
  qc.setQueryData(["experiment-tests", SETUP_ID], setupVersions);
  qc.setQueryData(["experiment-tests", DRIVING_ID], drivingVersions);
  qc.setQueryData(["experiment-lap-metrics", SETUP_ID], lapMetrics(setupLaps));
  qc.setQueryData(["experiment-lap-metrics", DRIVING_ID], lapMetrics(drivingLaps));
  qc.setQueryData(["experiment-actions", SETUP_ID], []);
  qc.setQueryData(["experiment-actions", DRIVING_ID], []);
  qc.setQueryData(["laps", null], allLaps);
  qc.setQueryData(["laps", "acc"], allLaps);
  // The list rows resolve a car's folder name to a display name via
  // `useAccCarName`. Seed it so a story never depends on the network: Storybook
  // has no API behind it, and an unseeded fetch leaves the list stuck on its
  // loading state instead of rendering.
  qc.setQueryData(["acc-cars"], [{ model: "huracan_gt3_evo2", name: "Huracan GT3" }]);
  return qc;
}

function withProviders(Story: React.ComponentType) {
  const qc = seededClient();
  const Comp = () => (
    <QueryClientProvider client={qc}>
      <div style={{ height: "100vh", overflow: "hidden", background: "var(--app-bg)" }}>
        <Story />
      </div>
    </QueryClientProvider>
  );
  const rootRoute = createRootRoute({ component: Comp });
  // Root-only route tree, so the entry must be "/" — any deeper path simply
  // does not match and the story renders blank. These screens take their ids
  // as props and only use the router for navigation, which is a no-op here.
  const router = createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) });
  return <RouterProvider router={router} />;
}

const meta: Meta = {
  title: "Dashboards/Experiments/Flow",
  parameters: { layout: "fullscreen" },
};
export default meta;

// ── 1. List ─────────────────────────────────────────────────────────────────

/** Both experiments side by side. Note what is missing: nothing on a row says
 *  whether it is a setup or a driving experiment, because `experiments.kind`
 *  does not exist yet. */
export const ListBothVariants: StoryObj = {
  render: () => <ExperimentList gameId="acc" onOpen={() => {}} />,
  decorators: [(Story) => withProviders(Story)],
};

/** The empty state a new driver lands on. */
export const ListEmpty: StoryObj = {
  render: () => <ExperimentList gameId="acc" onOpen={() => {}} />,
  decorators: [
    (Story) => {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
      qc.setQueryData(["experiments", "acc"], []);
      const Comp = () => (
        <QueryClientProvider client={qc}>
          <div style={{ height: "100vh", background: "var(--app-bg)" }}>
            <Story />
          </div>
        </QueryClientProvider>
      );
      const rootRoute = createRootRoute({ component: Comp });
      return (
        <RouterProvider
          router={createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) })}
        />
      );
    },
  ],
};

// ── 2. Workspace ────────────────────────────────────────────────────────────

/** Setup variant: two versions, the applied knob change on v2, driver comment. */
export const WorkspaceSetup: StoryObj = {
  render: () => <ExperimentWorkspace gameId="acc" experimentId={SETUP_ID} />,
  decorators: [(Story) => withProviders(Story)],
};

/** Driving variant: arms are drills with no setup file. The version rows render
 *  the drill's title, target corner and instruction via the same
 *  `AppliedChangesList` the setup variant uses. */
export const WorkspaceDriving: StoryObj = {
  render: () => <ExperimentWorkspace gameId="acc" experimentId={DRIVING_ID} />,
  decorators: [(Story) => withProviders(Story)],
};

// ── 3. Review ───────────────────────────────────────────────────────────────

/** Setup variant, reviewing v2's stint — the arm the change was applied to. */
export const ReviewSetup: StoryObj = {
  render: () => <TestReviewPage gameId="acc" experimentId={SETUP_ID} versionId={101} />,
  decorators: [(Story) => withProviders(Story)],
};

/**
 * Driving variant, reviewing the drill arm. The laps here are ~0.06s apart on
 * best lap but half the spread of the baseline arm — so a lap-time read says
 * "no change" and the actual result is invisible on this screen today. This is
 * the concrete argument for the outcome-metric selector in Phase 3.
 */
export const ReviewDriving: StoryObj = {
  render: () => <TestReviewPage gameId="acc" experimentId={DRIVING_ID} versionId={201} />,
  decorators: [(Story) => withProviders(Story)],
};
