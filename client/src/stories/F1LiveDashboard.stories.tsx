import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient } from "@tanstack/react-query";
import { F1LiveDashboard } from "../components/f1/F1LiveDashboard";
import { useGameStore } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { fakeF1SemanticFixture, fakePit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
// Seed every query rendered by dashboard so standalone Storybook stays offline.
queryClient.setQueryData(["laps", "f1-2025"], fakeSessionLaps);
queryClient.setQueryData(["track-name", 7, "f1-2025"], "Bahrain International Circuit");
queryClient.setQueryData(["car-name", 42, "f1-2025"], "F1 2025");

function StoryDecorator({ story }: { story: React.ComponentType }) {
  // Inject fake state into stores before render
  const { schema, frame, view } = fakeF1SemanticFixture;
  useTelemetryStore.setState({
    connected: true,
    telemetrySchema: schema,
    telemetryFrame: frame,
    telemetryView: view,
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

  return <LiveDashboardStoryFrame queryClient={queryClient} story={story} />;
}

const meta: Meta<typeof F1LiveDashboard> = {
  title: "Dashboards/F1LiveDashboard",
  component: F1LiveDashboard,
  decorators: [(Story) => <StoryDecorator story={Story} />],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof F1LiveDashboard>;

export const Default: Story = {};
