import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
      <div className="dark" style={{ height: "100vh", overflow: "auto", background: "#0a0a0a" }}>
        {children}
      </div>
    </QueryClientProvider>
  );
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
  ],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ForzaLiveDashboard>;

export const Default: Story = {};
