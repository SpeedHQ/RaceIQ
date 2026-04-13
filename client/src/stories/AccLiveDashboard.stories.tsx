import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTelemetryStore } from "../stores/telemetry";
import { useGameStore } from "../stores/game";
import { AccLiveDashboard } from "../components/acc/AccLiveDashboard";
import {
  fakeAccPacket,
  fakeAccDisplayPacket,
  fakeSectors,
  fakePit,
  fakeSessionLaps,
} from "./fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "acc"], fakeSessionLaps);

function StoryDecorator({ children }: { children: React.ReactNode }) {
  useTelemetryStore.setState({
    connected: true,
    rawPacket: fakeAccPacket,
    packet: fakeAccDisplayPacket,
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
      detectedGame: { id: "acc", name: "Assetto Corsa Competizione" },
      currentSession: { id: 3, carOrdinal: 301, trackOrdinal: 7 },
    },
  });

  useGameStore.setState({ gameId: "acc" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>
        {children}
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof AccLiveDashboard> = {
  title: "Dashboards/AccLiveDashboard",
  component: AccLiveDashboard,
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
type Story = StoryObj<typeof AccLiveDashboard>;

export const Default: Story = {};
