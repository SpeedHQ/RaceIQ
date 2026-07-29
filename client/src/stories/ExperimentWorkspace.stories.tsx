import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ExperimentWorkspace } from "../components/tunes/ExperimentWorkspace";
import type { Experiment, ExperimentLapMetric, ExperimentVersion } from "../hooks/queries";
import { fakeSessionLaps } from "./fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const sessionId = 42;

const fakeSession: Experiment = {
  id: sessionId,
  gameId: "acc",
  seq: 7,
  name: "Spa qualifying setup",
  carOrdinal: null,
  trackOrdinal: null,
  carName: "Huracan GT3",
  trackName: "Spa-Francorchamps",
  headVersionId: 101,
  createdAt: new Date().toISOString(),
} as Experiment;

const fakeTests: ExperimentVersion[] = [
  {
    id: 100,
    experimentId: sessionId,
    version: 1,
    label: "Base setup",
    setupPath: "C:/setups/race_dry.json",
    parentVersionId: null,
    appliedChanges: null,
    driverComment: null,
    engine: null,
    status: "active",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    lapCount: 3,
    bestLapMs: 132450,
  },
  {
    id: 101,
    experimentId: sessionId,
    version: 2,
    label: "+1 rear wing, softer rear ARB",
    setupPath: null,
    parentVersionId: 100,
    appliedChanges: JSON.stringify([{ path: "aero.rearWing", from: 4, to: 5 }]),
    driverComment: "Less snap on corner exit",
    engine: "llm",
    status: "active",
    // Must predate every statusExampleLap below (oldest is ~25min back) — laps
    // are grouped to the newest test whose createdAt is <= the lap's createdAt
    // (ExperimentWorkspace.tsx lapsByTest), so a too-recent test creation
    // time silently drops older stint laps back onto v1.
    createdAt: new Date(Date.now() - 1_700_000).toISOString(),
    lapCount: 16,
    bestLapMs: 94200,
  },
];

// Extra laps against version 2 (test 101, created 10min ago) — a realistic
// stint order, not a bare enum dump: leave pit (outlap) → clean run → box
// (inlap → pit lap) → back out → one more clean lap → then a handful of
// telemetry anomalies, each tagged with its source. Covers every
// invalidReason value the pipeline produces.
const statusExampleLapsBase = [
  { id: 201, lapNumber: 11, invalidReason: "outlap" }, // acc-lap-rules.ts: left pit, ended on track
  { id: 202, lapNumber: 12, invalidReason: null },
  { id: 203, lapNumber: 13, invalidReason: null },
  { id: 204, lapNumber: 14, invalidReason: null },
  { id: 205, lapNumber: 15, invalidReason: "inlap" }, // acc-lap-rules.ts: started on track, boxed
  { id: 206, lapNumber: 16, invalidReason: "pit lap" }, // acc-lap-rules.ts: both ends in pit
  { id: 207, lapNumber: 17, invalidReason: "outlap" }, // back out after the stop
  { id: 208, lapNumber: 18, invalidReason: null },
  { id: 209, lapNumber: 19, invalidReason: "telemetry lap time mismatch" }, // lap-quality.ts
  { id: 210, lapNumber: 20, invalidReason: "too few telemetry packets" }, // lap-quality.ts
  { id: 211, lapNumber: 21, invalidReason: "telemetry distance too short" }, // lap-quality.ts
  { id: 212, lapNumber: 22, invalidReason: "start/end positions too far apart" }, // lap-quality.ts
  { id: 213, lapNumber: 1, invalidReason: "starting lap" }, // lap-quality.ts: first lap of session, no valid start line crossing
  { id: 214, lapNumber: 23, invalidReason: "rewind" }, // lap-detector.ts: mid-lap timestamp rewind
  { id: 215, lapNumber: 24, invalidReason: "incomplete" }, // lap-detector.ts: session ended mid-lap
  { id: 216, lapNumber: 25, invalidReason: "lap skip (25 → 27)" }, // lap-detection.ts: dropped packets, lap counter jumped
];
const statusLapCount = statusExampleLapsBase.length;
const statusExampleLaps = statusExampleLapsBase.map((l, i) => ({
  ...l,
  sessionId: 1,
  experimentId: sessionId,
  isValid: l.invalidReason === null,
  lapTime: 94.2 + i * 0.3,
  createdAt: new Date(Date.now() - (statusLapCount - i) * 95_000).toISOString(),
  carOrdinal: 42,
  trackOrdinal: 7,
  sectorTimes: [30.1, 33.5, 30.6],
}));

const sessionLaps = [...fakeSessionLaps.map((l) => ({ ...l, experimentId: sessionId })), ...statusExampleLaps];

// Server-derived per-lap metrics for every lap in the pool (not just laps 1-10):
// fuel drifts run-to-run and tyre wear climbs across the stint, so the workspace
// stat cards, VersionGraph "worst wear" column, and the per-lap breakdown all show
// realistic example data instead of "—". Wear is the worst-tyre % worn at lap end.
const fakeLapMetrics: ExperimentLapMetric[] = sessionLaps.map((l, i) => ({
  lapId: l.id,
  fuelPerLap: +(2.7 + Math.sin(i / 3) * 0.25).toFixed(2),
  tyreWear: +(3 + i * 1.4).toFixed(1),
}));

queryClient.setQueryData(["experiment", sessionId], fakeSession);
queryClient.setQueryData(["experiment-tests", sessionId], fakeTests);
queryClient.setQueryData(["experiment-lap-metrics", sessionId], fakeLapMetrics);
queryClient.setQueryData(["laps", null], sessionLaps);
queryClient.setQueryData(["laps", "acc"], sessionLaps);

function StoryDecorator({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "hidden", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
  );
}

function withRouter(Story: React.ComponentType) {
  const Comp = () => <Story />;
  const rootRoute = createRootRoute({ component: Comp });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/acc/experiments/${sessionId}`] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof ExperimentWorkspace> = {
  title: "Dashboards/Experiments/Workspace",
  component: ExperimentWorkspace,
  decorators: [
    (Story) => (
      <StoryDecorator>
        <Story />
      </StoryDecorator>
    ),
    (Story) => withRouter(Story),
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ExperimentWorkspace>;

export const Default: Story = {
  args: { gameId: "acc", experimentId: sessionId },
};
