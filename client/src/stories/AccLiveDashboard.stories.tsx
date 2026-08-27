import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient } from "@tanstack/react-query";
import { AccLiveDashboard } from "../components/acc/AccLiveDashboard";
import { gameStore } from "../stores/game";
import { telemetryStore } from "../stores/telemetry";
import { fakeAccSemanticFixture, fakePit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "acc"], fakeSessionLaps);

function StoryDecorator({ story }: { story: React.ComponentType }) {
  const { schema, frame, view } = fakeAccSemanticFixture;
  telemetryStore.setState({
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
      telemetryPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "acc", name: "Assetto Corsa Competizione" },
      currentSession: { id: 3, carOrdinal: 301, trackOrdinal: 7 },
    },
  });

  gameStore.setState((prev) => ({ ...prev, gameId: "acc" }));

  return <LiveDashboardStoryFrame queryClient={queryClient} story={story} />;
}

const meta: Meta<typeof AccLiveDashboard> = {
  title: "Dashboards/AccLiveDashboard",
  component: AccLiveDashboard,
  decorators: [(Story) => <StoryDecorator story={Story} />],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof AccLiveDashboard>;

export const VisualContract: Story = {};
