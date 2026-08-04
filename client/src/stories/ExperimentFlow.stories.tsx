import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { fireEvent, userEvent, within } from "storybook/test";
import { ExperimentWorkspace } from "@/components/tunes/ExperimentWorkspace";
import { ExperimentList } from "@/components/tunes/experiment/ExperimentList";
import { TestReviewPage } from "@/components/tunes/review/TestReviewPage";
import type { Experiment, ExperimentLapMetric, ExperimentVersion } from "@/hooks/experiments";

/**
 * The experiment flow end to end — list → workspace → review — in both
 * variants: a CAR-focus experiment (arms are setup versions) and a DRIVER-focus
 * experiment (arms are drills, no setup file).
 *
 * These stories now describe shipped behaviour rather than a spec. Focus
 * (migration v39) is a MODE on `experiments` that the driver switches
 * mid-session — fix the balance, then work on braking, same experiment — and
 * each arm records the kind it was created under in `experiment_versions.kind`,
 * which never changes afterwards. So:
 *
 *   - the list badges each row with its current focus (FocusBadge)
 *   - creation offers a starting focus, and a driver-focus experiment needs no
 *     base setup file
 *   - the workspace header carries the switcher, and the review dashboard
 *     leads with the metric that arm's kind is actually judged on
 *
 * The driver-focus fixtures below still hand-seed their arms, because the drill-arm
 * *authoring* form (issue #120 Phase 3) does not exist yet — the agent writes
 * drills through the chat. What they demonstrate is the read path: lap times
 * barely move between the two drill arms while the SPREAD halves, which is
 * the case a best-lap headline cannot express.
 */

const CAR_ID = 42;
const DRIVER_ID = 43;

/** Filename the drop story uploads; also seeded into the Setups listing so the
 *  drop matches an existing file instead of hitting `place-setup`. */
const DROPPED_SETUP_NAME = "quali_low_fuel.json";

/** Minimal ACC setup JSON — enough to clear `AccSetupJsonSchema`'s shape gate
 *  (carName + basicSetup), which is what the drop handler validates against. */
const ACC_SETUP_JSON = {
  carName: "huracan_gt3_evo2",
  basicSetup: { tyres: { tyreCompound: 0, tyrePressure: [49, 50, 49, 49] } },
};

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
    // Focus is a mode, so the default here is the one every experiment opens on
    // unless the driver says otherwise.
    focus: "car",
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
    kind: "setup",
    status: "active",
    createdAt: ago(3_600_000),
    lapCount: 0,
    bestLapMs: null,
    ...over,
  } as ExperimentVersion;
}

/** A stint of laps against one version. `spread` widens the lap-time scatter,
 *  which is the whole signal a driver-focus experiment is measuring. */
function stint(opts: { startId: number; experimentId: number; versionId: number; count: number; base: number; spread: number; startedMsAgo: number }) {
  const { startId, experimentId, versionId, count, base, spread, startedMsAgo } = opts;
  return Array.from({ length: count }, (_, i) => {
    // Deterministic pseudo-scatter — stories must not change between reloads.
    const jitter = (((Math.sin(i * 12.9898) * 43758.5453) % 1) + 1) % 1;
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
      sectorTimes: [30.1, 33.5, 30.6],
    };
  });
}

// ── Car-focus variant ───────────────────────────────────────────────────────
// Two arms, a real applied change between them, and the driver's verdict.

const carExperiment = experiment({
  id: CAR_ID,
  seq: 7,
  name: "Spa — rear stability on entry",
  baseSetupPath: "C:/setups/spa_race_dry.json",
});

const carVersions: ExperimentVersion[] = [
  version({
    id: 100,
    experimentId: CAR_ID,
    version: 1,
    label: "Base setup",
    setupPath: "C:/setups/spa_race_dry.json",
    createdAt: ago(7_200_000),
    lapCount: 8,
    bestLapMs: 138_420,
  }),
  version({
    id: 101,
    experimentId: CAR_ID,
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

const carLaps = [
  ...stint({ startId: 1000, experimentId: CAR_ID, versionId: 100, count: 8, base: 138.4, spread: 0.55, startedMsAgo: 7_000_000 }),
  ...stint({ startId: 1100, experimentId: CAR_ID, versionId: 101, count: 9, base: 137.98, spread: 0.5, startedMsAgo: 3_400_000 }),
];

// ── Driver-focus variant ────────────────────────────────────────────────────
// Same machinery, arms are drills. No setupPath anywhere — that is the point:
// the schema already allows a version with no setup file behind it.
//
// The lap times barely move between arms while the SPREAD halves, which is
// exactly the case lap time cannot express and `consistencySpreadSec` can.

const driverExperiment = experiment({
  id: DRIVER_ID,
  seq: 8,
  name: "Spa — brake-release consistency",
  carName: "Huracan GT3",
  focus: "driver",
});

const driverVersions: ExperimentVersion[] = [
  version({
    id: 200,
    experimentId: DRIVER_ID,
    kind: "drill",
    version: 1,
    label: "Baseline — drive normally",
    createdAt: ago(7_200_000),
    lapCount: 10,
    bestLapMs: 138_600,
  }),
  version({
    id: 201,
    experimentId: DRIVER_ID,
    kind: "drill",
    version: 2,
    label: "Trail-brake to the apex at Les Combes",
    parentVersionId: 200,
    appliedChanges: JSON.stringify([
      {
        kind: "drill",
        title: "Trail-brake to the apex at Les Combes",
        instruction: "Carry 10 bar of brake pressure past turn-in and release it progressively to zero at the apex, instead of releasing everything before you turn.",
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

const driverLaps = [
  ...stint({ startId: 2000, experimentId: DRIVER_ID, versionId: 200, count: 10, base: 138.6, spread: 1.4, startedMsAgo: 7_000_000 }),
  ...stint({ startId: 2100, experimentId: DRIVER_ID, versionId: 201, count: 11, base: 138.54, spread: 0.6, startedMsAgo: 3_400_000 }),
];

const allLaps = [...carLaps, ...driverLaps];

const lapMetrics = (laps: typeof allLaps): ExperimentLapMetric[] =>
  laps.map((l, i) => ({
    lapId: l.id,
    fuelPerLap: +(2.7 + Math.sin(i / 3) * 0.25).toFixed(2),
    tyreWear: +(3 + i * 1.2).toFixed(1),
  }));

function seededClient() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(["experiments", "acc"], [carExperiment, driverExperiment]);
  qc.setQueryData(["experiment", CAR_ID], carExperiment);
  qc.setQueryData(["experiment", DRIVER_ID], driverExperiment);
  qc.setQueryData(["experiment-tests", CAR_ID], carVersions);
  qc.setQueryData(["experiment-tests", DRIVER_ID], driverVersions);
  qc.setQueryData(["experiment-lap-metrics", CAR_ID], lapMetrics(carLaps));
  qc.setQueryData(["experiment-lap-metrics", DRIVER_ID], lapMetrics(driverLaps));
  qc.setQueryData(["experiment-actions", CAR_ID], []);
  qc.setQueryData(["experiment-actions", DRIVER_ID], []);
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

/** Both experiments side by side, each row badged with its current focus
 *  (FocusBadge) — the badge tracks `experiments.focus`, so it follows a
 *  mid-session switch rather than describing how the experiment started. */
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
      return <RouterProvider router={createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) })} />;
    },
  ],
};

// ── 1b. New-experiment modal: the dropped-setup card ────────────────────────

/**
 * The state after a driver drops a setup file into "New experiment".
 *
 * Worth a story of its own because it is pure client state — there is no route
 * that renders it and no query that produces it, so it was previously only
 * reachable by having the game installed and a real setup on disk. That is how
 * it ended up shipping as a stack of contradictory status sentences ("Placed X
 * …" directly above "X is already in your Setups folder").
 *
 * The seeded Setups listing contains the same filename the story uploads, so
 * the drop resolves against it and pins car + track without any network call —
 * the `place-setup` POST is never reached.
 */
export const NewExperimentDroppedSetup: StoryObj = {
  render: () => <ExperimentList gameId="acc" onOpen={() => {}} />,
  decorators: [
    (Story) => {
      const qc = seededClient();
      qc.setQueryData(["setup-files", "acc"], {
        baseDir: "C:/Users/driver/Documents/Assetto Corsa Competizione/Setups",
        files: [
          {
            carModel: "huracan_gt3_evo2",
            trackName: "spa",
            fileName: DROPPED_SETUP_NAME,
            absolutePath: `C:/Setups/huracan_gt3_evo2/spa/${DROPPED_SETUP_NAME}`,
          },
        ],
        tracks: ["spa", "monza", "sebring"],
        trackNames: { spa: "Spa-Francorchamps", monza: "Monza", sebring: "Sebring GP" },
        cars: [{ model: "huracan_gt3_evo2", name: "Huracan GT3" }],
      });
      const Comp = () => (
        <QueryClientProvider client={qc}>
          <div style={{ height: "100vh", background: "var(--app-bg)" }}>
            <Story />
          </div>
        </QueryClientProvider>
      );
      const rootRoute = createRootRoute({ component: Comp });
      return <RouterProvider router={createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/"] }) })} />;
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /New experiment/i }));
    // The modal is a portal, so it lands on document.body rather than inside
    // the canvas element.
    const modal = within(document.body);
    const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("file input not rendered");
    const file = new File([JSON.stringify(ACC_SETUP_JSON)], DROPPED_SETUP_NAME, { type: "application/json" });
    // `hidden` inputs reject userEvent.upload's visibility check — fireEvent is
    // what the real click-to-browse path ends up doing anyway.
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
    // The card only appears after processFile awaits file.text().
    await modal.findByText(/Found in Setups/i);
  },
};

// ── 2. Workspace ────────────────────────────────────────────────────────────

/** Car focus: two setup arms, the applied knob change on v2, driver comment. */
export const WorkspaceCarFocus: StoryObj = {
  render: () => <ExperimentWorkspace gameId="acc" experimentId={CAR_ID} />,
  decorators: [(Story) => withProviders(Story)],
};

/**
 * The workspace of a DRIVER-focus experiment.
 *
 * Same screen as WorkspaceCarFocus — the point is what differs without any
 * separate "coaching" route existing: the header switcher reads Driver, and
 * the agent panel is titled Driver coach rather than Race engineer.
 *
 * Its arms are drills with no setup file, and the version rows render the
 * drill's title, target corner and instruction via the same
 * `AppliedChangesList` the car-focus variant uses.
 */
export const WorkspaceDriverFocus: StoryObj = {
  render: () => <ExperimentWorkspace gameId="acc" experimentId={DRIVER_ID} />,
  decorators: [(Story) => withProviders(Story)],
};

// ── 3. Review ───────────────────────────────────────────────────────────────

/** Car focus, reviewing v2's stint — the arm the change was applied to. */
export const ReviewCarFocus: StoryObj = {
  render: () => <TestReviewPage gameId="acc" experimentId={CAR_ID} versionId={101} />,
  decorators: [(Story) => withProviders(Story)],
};

/**
 * Driver focus, reviewing the drill arm. The laps here are ~0.06s apart on
 * best lap but half the spread of the baseline arm — so a lap-time read says
 * "no change" and the actual result is invisible on this screen today. This is
 * the concrete argument for the outcome-metric selector in Phase 3.
 */
export const ReviewDriverFocus: StoryObj = {
  render: () => <TestReviewPage gameId="acc" experimentId={DRIVER_ID} versionId={201} />,
  decorators: [(Story) => withProviders(Story)],
};
