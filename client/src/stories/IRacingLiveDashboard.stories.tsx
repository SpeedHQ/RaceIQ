import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient } from "@tanstack/react-query";
import { ForzaLiveDashboard } from "../components/ForzaLiveDashboard";
import { gameStore } from "../stores/game";
import { telemetryStore } from "../stores/telemetry";
import { fakeFuelOnlyPit, fakeIRacingSemanticFixture, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
queryClient.setQueryData(["laps", "iracing"], fakeSessionLaps);
queryClient.setQueryData(["track-name", 101, "iracing"], "Watkins Glen International");
queryClient.setQueryData(["car-name", 1001, "iracing"], "GT3");

function StoryDecorator({ story }: { story: React.ComponentType }) {
  const { schema, frame, view } = fakeIRacingSemanticFixture;
  telemetryStore.setState((prev) => ({
    ...prev,
    connected: true,
    telemetrySchema: schema,
    telemetryFrame: frame,
    telemetryView: view,
    sectors: fakeSectors,
    pit: fakeFuelOnlyPit,
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
      detectedGame: { id: "iracing", name: "iRacing" },
      currentSession: { id: 5, carOrdinal: 1001, trackOrdinal: 101 },
    },
  }));

  gameStore.setState((prev) => ({ ...prev, gameId: "iracing" }));

  return <LiveDashboardStoryFrame queryClient={queryClient} story={story} />;
}

const meta: Meta<typeof ForzaLiveDashboard> = {
  title: "Dashboards/IRacingLiveDashboard",
  component: ForzaLiveDashboard,
  args: { mode: "driver" },
  decorators: [(Story) => <StoryDecorator story={Story} />],
  parameters: {
    layout: "fullscreen",
  },
};

export default meta;
type Story = StoryObj<typeof ForzaLiveDashboard>;

export const VisualContract: Story = {};
