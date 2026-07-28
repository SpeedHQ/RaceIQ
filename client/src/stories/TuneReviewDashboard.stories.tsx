import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { TuneReviewDashboard } from "../components/tunes/TuneReviewDashboard";
import { fakeSessionLaps } from "./fakeData";
import { fakeSectorTimes, fakeTuneIssues, generateFakeLapTelemetry } from "./setupEngineerFakeLap";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const lapId = fakeSessionLaps[fakeSessionLaps.length - 1].id;
queryClient.setQueryData(["lap-telemetry", lapId], { telemetry: generateFakeLapTelemetry(), sectorTimes: fakeSectorTimes });
queryClient.setQueryData(["lap-issues", lapId], fakeTuneIssues);
queryClient.setQueryData(["setup-files", "acc"], { baseDir: "C:/setups", files: [{ carModel: "Huracan GT3", trackName: "Spa", fileName: "race_dry.json", absolutePath: "C:/setups/race_dry.json" }] });

function StoryDecorator({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
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
