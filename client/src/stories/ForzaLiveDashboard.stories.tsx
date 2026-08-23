import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient } from "@tanstack/react-query";
import { ForzaLiveDashboard } from "../components/ForzaLiveDashboard";
import { gameStore, useGameStore } from "../stores/game";
import { telemetryStore, useTelemetryStore } from "../stores/telemetry";
import { fakeForzaDisplayPacket, fakeForzaPacket, fakeForzaSemanticFixture, fakePit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "fm-2023"], fakeSessionLaps);

function StoryDecorator({ story }: { story: React.ComponentType }) {
  const { schema, frame, view } = fakeForzaSemanticFixture;
  telemetryStore.setState((prev) => ({ ...prev,
    connected: true,
    telemetrySchema: schema,
    telemetryFrame: frame,
    telemetryView: view,
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
      telemetryPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "fm-2023", name: "Forza Motorsport" },
      currentSession: { id: 2, carOrdinal: 1742, trackOrdinal: 7 },
    },
  }));

  gameStore.setState((prev) => ({ ...prev, gameId: "fm-2023" }));

  return <LiveDashboardStoryFrame queryClient={queryClient} story={story} />;
}

const meta: Meta<typeof ForzaLiveDashboard> = {
  title: "Dashboards/ForzaLiveDashboard",
  component: ForzaLiveDashboard,
  decorators: [(Story) => <StoryDecorator story={Story} />],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ForzaLiveDashboard>;

export const Default: Story = {};
