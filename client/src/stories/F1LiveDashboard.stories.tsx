import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTelemetryStore } from "../stores/telemetry";
import { useGameStore } from "../stores/game";
import { F1LiveDashboard } from "../components/f1/F1LiveDashboard";
import {
  fakeF1Packet,
  fakeF1DisplayPacket,
  fakeSectors,
  fakePit,
  fakeSessionLaps,
} from "./fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// Pre-seed LapTimeChart query so it renders without a server
queryClient.setQueryData(["laps", "f1-2025"], fakeSessionLaps);

function StoryDecorator({ children }: { children: React.ReactNode }) {
  // Inject fake state into stores before render
  useTelemetryStore.setState({
    connected: true,
    rawPacket: fakeF1Packet,
    packet: fakeF1DisplayPacket,
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
      detectedGame: { id: "f1-2025", name: "F1 25" },
      currentSession: { id: 1, carOrdinal: 42, trackOrdinal: 7 },
    },
  });

  useGameStore.setState({ gameId: "f1-2025" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>
        {children}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof F1LiveDashboard> = {
  title: "Dashboards/F1LiveDashboard",
  component: F1LiveDashboard,
  decorators: [
    (Story) => (
      <StoryDecorator>
        <Story />
      </StoryDecorator>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof F1LiveDashboard>;

export const Default: Story = {};
