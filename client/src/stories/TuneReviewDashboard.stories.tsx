import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { GameStoryScope } from "./GameStoryScope";
import { TuneReviewDashboard } from "@/components/tunes/review/TuneReviewDashboard";
import { fakeSessionLaps } from "./fakeData";
import { fakeSectorTimes, fakeTuneIssues, generateFakeLapTelemetry } from "./setupEngineerFakeLap";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const focusLap = fakeSessionLaps[fakeSessionLaps.length - 1];
const lapId = focusLap.id;
queryClient.setQueryData(["lap-telemetry", lapId], { telemetry: generateFakeLapTelemetry(), sectorTimes: fakeSectorTimes });
queryClient.setQueryData(["lap-issues", lapId], fakeTuneIssues);
queryClient.setQueryData(["setup-files", "acc"], { baseDir: "C:/setups", files: [{ carModel: "Huracan GT3", trackName: "Spa", fileName: "race_dry.json", absolutePath: "C:/setups/race_dry.json" }] });
queryClient.setQueryData(["acc-car-class", focusLap.carOrdinal], "GT3");
queryClient.setQueryData(["resolve-names", "acc", "7", "42"], { trackNames: { "7": "Spa-Francorchamps" }, carNames: { "42": "Huracan GT3" } });
queryClient.setQueryData(["resolve-names", null, "7", "42"], { trackNames: { "7": "Spa-Francorchamps" }, carNames: { "42": "Huracan GT3" } });
queryClient.setQueryData(["lap-semantic-telemetry", 10, "acc"], []);
function StoryDecorator({ children }: { children: React.ReactNode }) {
  return (
    <GameStoryScope gameId="acc">
      <QueryClientProvider client={queryClient}>
        <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>{children}</div>
      </QueryClientProvider>
    </GameStoryScope>
  );
}

function withRouter(Story: React.ComponentType) {
  const Comp = () => <Story />;
  const rootRoute = createRootRoute({ component: Comp });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/?lap=${lapId}`] }),
  });
  return <RouterProvider router={router} />;
}

const meta: Meta<typeof TuneReviewDashboard> = {
  title: "Dashboards/Experiments/TuneReviewDashboard",
  component: TuneReviewDashboard,
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
type Story = StoryObj<typeof TuneReviewDashboard>;

export const Default: Story = {
  args: { gameId: "acc", trackName: "Spa-Francorchamps", laps: fakeSessionLaps },
};
