import type { HistoricalBaseline, PitEstimateRecord, StintSummary } from "@raceiq/shared/racing/live/strategy";
import type { RacePlan } from "@raceiq/shared/racing/live/race-plan";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useState } from "react";
import { ResponsiveWorkspace } from "../components/ResponsiveWorkspace";
import { RaceStrategyProvider, useRaceStrategyHost } from "@raceiq/race-strategy/ui";
import type { RaceStrategyHost } from "@raceiq/race-strategy/contracts";
import { RaceStrategyHostProvider } from "../features/race-strategy-host";

interface LiveDashboardStoryFrameProps {
  queryClient: QueryClient;
  story: ComponentType;
  activePlans?: RacePlan[];
  strategyEvidence?: { stints: StintSummary[]; estimates: PitEstimateRecord[]; baseline: HistoricalBaseline };
}

function StoryActivePlansHost({ children, activePlans, strategyEvidence }: { children: ReactNode; activePlans?: RacePlan[]; strategyEvidence?: LiveDashboardStoryFrameProps["strategyEvidence"] }) {
  const host = useRaceStrategyHost();
  if (!activePlans && !strategyEvidence) return children;
  const storyHost: RaceStrategyHost = {
    ...host,
    api: {
      ...host.api,
      ...(activePlans ? { activePlans: async () => ({ plans: activePlans }) } : {}),
      ...(strategyEvidence ? {
        stints: async () => ({ stints: strategyEvidence.stints }),
        estimates: async () => ({ estimates: strategyEvidence.estimates, nextCursor: "older" }),
        baseline: async () => ({ baseline: strategyEvidence.baseline }),
      } : {}),
    },
  };
  return <RaceStrategyProvider value={storyHost}>{children}</RaceStrategyProvider>;
}


export function LiveDashboardStoryFrame({ queryClient, story: Story, activePlans, strategyEvidence }: LiveDashboardStoryFrameProps) {
  const [router] = useState(() => {
    const rootRoute = createRootRoute({ component: () => <Story /> });
    return createRouter({
      routeTree: rootRoute,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div className="h-screen bg-app-bg text-app-text">
        <ResponsiveWorkspace>
          <RaceStrategyHostProvider>
            <StoryActivePlansHost activePlans={activePlans} strategyEvidence={strategyEvidence}><RouterProvider router={router} /></StoryActivePlansHost>
          </RaceStrategyHostProvider>
        </ResponsiveWorkspace>
      </div>
    </QueryClientProvider>
  );
}
