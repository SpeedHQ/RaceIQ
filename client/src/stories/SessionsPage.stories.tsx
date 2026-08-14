import { MOTEC_SESSION_SOURCE } from "@shared/integrations/motec";
import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { LapMeta, SessionMeta } from "../../../shared/racing/sessions/types";
import { SessionsPage } from "../components/sessions/SessionsPage";
import { GameStoryScope } from "./GameStoryScope";

const gameId = "ac-evo";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

function makeLaps(sessionId: number, count: number, base: number): LapMeta[] {
  return Array.from({ length: count }, (_, i) => ({
    id: sessionId * 100 + i,
    sessionId,
    lapNumber: i + 1,
    lapTime: +(base + Math.sin(i) * 0.4).toFixed(3),
    isValid: true,
    phase: i === 0 ? "out" : "flying",
    conditions: [],
    paceEligibility: i === 0 ? "excluded" : "eligible",
    carOrdinal: 42,
    trackOrdinal: 7,
    sectorTimes: sessionId === 2 ? undefined : [30.1, 33.5, 30.6],
    createdAt: new Date(Date.now() - (count - i) * 95_000).toISOString(),
  })) as unknown as LapMeta[];
}

// Two recorded sessions and two MoTeC imports. The imports carry the same
// shape as a recorded session — the only discriminator is `source`, which is
// exactly what the tab filter keys on, so the story proves the split rather
// than faking two different row types.
const sessions = [
  {
    id: 1,
    gameId,
    trackOrdinal: 7,
    carOrdinal: 42,
    lapCount: 6,
    bestLapTime: 94.201,
    sessionType: "practice",
    notes: "Long run on used tyres",
    source: null,
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
  },
  {
    id: 2,
    gameId,
    trackOrdinal: 12,
    carOrdinal: 43,
    lapCount: 4,
    bestLapTime: 412.887,
    sessionType: "race",
    notes: null,
    source: null,
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
  },
  {
    id: 3,
    gameId,
    trackOrdinal: 7,
    carOrdinal: 42,
    lapCount: 3,
    bestLapTime: 93.118,
    sessionType: "practice",
    notes: "Coach reference lap (MoTeC)",
    source: MOTEC_SESSION_SOURCE,
    createdAt: new Date(Date.now() - 1_800_000).toISOString(),
  },
  {
    id: 4,
    gameId,
    trackOrdinal: 12,
    carOrdinal: 43,
    lapCount: 2,
    bestLapTime: 408.442,
    sessionType: "qualifying",
    notes: null,
    source: MOTEC_SESSION_SOURCE,
    createdAt: new Date(Date.now() - 900_000).toISOString(),
  },
] as unknown as SessionMeta[];

const laps = [...makeLaps(1, 6, 94.2), ...makeLaps(2, 4, 412.9), ...makeLaps(3, 3, 93.1), ...makeLaps(4, 2, 408.4)];

queryClient.setQueryData(["sessions", gameId], sessions);
queryClient.setQueryData(["laps", gameId], laps);

/** The tab is a URL search param, so each story mounts its own history entry. */
function withRouter(Story: React.ComponentType, initialEntry: string) {
  const Comp = () => <Story />;
  const rootRoute = createRootRoute({ component: Comp });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof SessionsPage> = {
  title: "Dashboards/Sessions",
  component: SessionsPage,
  decorators: [
    (Story) => (
      <GameStoryScope gameId={gameId}>
        <QueryClientProvider client={queryClient}>
          <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>
            <Story />
          </div>
        </QueryClientProvider>
      </GameStoryScope>
    ),
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof SessionsPage>;

export const Recorded: Story = {
  decorators: [(Story) => withRouter(Story, "/ac-evo/sessions")],
};

export const Imported: Story = {
  decorators: [(Story) => withRouter(Story, "/ac-evo/sessions?tab=imported")],
};
