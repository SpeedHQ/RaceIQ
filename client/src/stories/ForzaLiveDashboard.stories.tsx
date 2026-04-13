import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, createMemoryHistory, RouterProvider, createRootRoute } from "@tanstack/react-router";
import { useTelemetryStore } from "../stores/telemetry";
import { useGameStore } from "../stores/game";
import { ForzaLiveDashboard } from "../components/ForzaLiveDashboard";
import {
  fakeForzaPacket,
  fakeForzaDisplayPacket,
  fakeSectors,
  fakePit,
  fakeSessionLaps,
} from "./fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "fm-2023"], fakeSessionLaps);

function StoryDecorator({ children }: { children: React.ReactNode }) {
  useTelemetryStore.setState({
    connected: true,
    rawPacket: fakeForzaPacket,
    packet: fakeForzaDisplayPacket,
    sectors: fakeSectors,
    pit: fakePit,
    sessionLaps: fakeSessionLaps,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    serverStatus: {
      udpPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "fm-2023", name: "Forza Motorsport" },
      currentSession: { id: 2, carOrdinal: 1742, trackOrdinal: 7 },
    },
  });

  useGameStore.setState({ gameId: "fm-2023" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>
        {children}
      </div>
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

const meta: Meta<typeof ForzaLiveDashboard> = {
  title: "Dashboards/ForzaLiveDashboard",
  component: ForzaLiveDashboard,
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
type Story = StoryObj<typeof ForzaLiveDashboard>;

export const Default: Story = {};
