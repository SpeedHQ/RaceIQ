import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import type { SessionMeta, SessionRecap as SessionRecapData } from "@shared/types";
import { HomePage } from "../components/HomePage";
import { useGameStore } from "../stores/game";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
import { generateFakeSessionLaps } from "./fakeData";

// Deterministic laps across the last few weeks so the activity heatmap, period
// stats and recent-laps table all render with stable content.
const laps = generateFakeSessionLaps(60, 7);

const sessions: SessionMeta[] = [
  {
    id: 1,
    carOrdinal: 42,
    trackOrdinal: 7,
    createdAt: laps[laps.length - 1]!.createdAt,
    lapCount: laps.length,
    bestLapTime: 91.98,
    sessionType: "practice",
    gameId: "fm-2023",
  },
];

const recap: SessionRecapData = {
  sessionId: 1,
  gameId: "fm-2023",
  carName: "2020 Porsche 911 GT3 R",
  trackName: "Laguna Seca",
  carOrdinal: 42,
  trackOrdinal: 7,
  createdAt: sessions[0]!.createdAt,
  lapsValid: 57,
  lapsTotal: 60,
  bestLapSec: 91.98,
  bestLapId: 10,
  timeOnTrackSec: 5280,
  distanceM: 205_000,
  sparkline: laps.map((l) => ({ lapNumber: l.lapNumber, lapTimeSec: l.lapTime, isValid: l.isValid })),
  theoretical: { bestS1: 29.68, bestS2: 32.05, bestS3: 30.25, sumSec: 91.98, deltaToBestSec: 0 },
  improvementSec: 3.44,
  consistency: { stdDevSec: 0.42, rating: 4 },
  personalBest: { isNew: true, previousBestSec: 93.1 },
  sectors: null,
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// Global homepage: gameId is null, so the laps/sessions keys are scoped to null.
queryClient.setQueryData(["laps", null], laps);
queryClient.setQueryData(["sessions", null], sessions);
queryClient.setQueryData(["settings"], DEFAULT_DISPLAY_SETTINGS);
queryClient.setQueryData(["session-recap", 1, "fm-2023"], recap);
// Per-game stat cards (fetched from /api/stats, uncapped by the 200-row laps limit).
queryClient.setQueryData(["stats", "fm-2023"], { totalLaps: 1240, totalTimeSec: 118_800 });
queryClient.setQueryData(["stats", "f1-2025"], { totalLaps: 620, totalTimeSec: 55_200 });
queryClient.setQueryData(["stats", "acc"], { totalLaps: 310, totalTimeSec: 28_400 });
queryClient.setQueryData(["stats", "ac-evo"], { totalLaps: 84, totalTimeSec: 6_900 });

function StoryDecorator({ children }: { children: React.ReactNode }) {
  // Global homepage view — no game selected.
  useGameStore.setState({ gameId: null });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ minHeight: "100vh", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
  );
}

// Minimal router so TanStack Router <Link> components don't crash
function withRouter(Story: React.ComponentType) {
  const Comp = () => <Story />;
  const rootRoute = createRootRoute({ component: Comp });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof HomePage> = {
  title: "Pages/HomePage",
  component: HomePage,
  decorators: [
    (Story) => (
      <StoryDecorator>
        <Story />
      </StoryDecorator>
    ),
    (Story) => withRouter(Story),
  ],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof HomePage>;

export const Default: Story = {};
