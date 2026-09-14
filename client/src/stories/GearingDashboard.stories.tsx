import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GearingDashboard } from "../components/telemetry/GearingDashboard";
import { ingestGearingTelemetry, resetGearingTelemetry, setGearingRecording, trackTrackSpeedSample } from "../lib/gearing-telemetry";
import { useGameStore } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { fakeForzaDisplayPacket } from "./fakeData";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

// Seed the gearing singletons with a fake lap so the Track Speed chart has a
// trace on mount. Module scope: runs once per storybook process.
resetGearingTelemetry();
setGearingRecording(true); // dyno recording defaults to off — enable it so the power band has data in the story
for (let i = 0; i < 450; i++) {
  // Two laps: lap 3 (first 300 samples), lap 4 (last 150) — exercises the
  // previous-lap retention and the toggle in the Track Speed chart.
  const lapNumber = i < 300 ? 3 : 4;
  const lapDist = i < 300 ? (i / 299) * 4400 : ((i - 300) / 149) * 4500;
  const speed = Math.max(0, 45 + 130 * Math.abs(Math.sin(lapDist / 550)) + 35 * Math.sin(lapDist / 230));
  const packet = {
    ...fakeForzaDisplayPacket,
    IsRaceOn: 1,
    Gear: 1 + Math.min(5, Math.floor(lapDist / 800)),
    CurrentEngineRpm: 4500 + (i % 40) * 50,
    DistanceTraveled: lapNumber * 10000 + lapDist,
    LapNumber: lapNumber,
    DisplaySpeed: lapNumber === 3 ? speed * 0.8 : speed,
    DisplayPower: 280 + (i % 20) * 10,
    DisplayTorque: 350 + (i % 10) * 5,
  };
  trackTrackSpeedSample(packet);
  ingestGearingTelemetry(packet);
}

function StoryDecorator({ children }: { children: React.ReactNode }) {
  useTelemetryStore.setState({
    connected: true,
    packet: fakeForzaDisplayPacket,
    rawPacket: fakeForzaDisplayPacket,
    isRaceOn: true,
  });
  useGameStore.setState({ gameId: "fm-2023" });

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "auto", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof GearingDashboard> = {
  title: "Dashboards/GearingDashboard",
  component: GearingDashboard,
  decorators: [
    (Story) => (
      <StoryDecorator>
        <Story />
      </StoryDecorator>
    ),
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof GearingDashboard>;

export const WithLapTrace: Story = {
  args: { packet: fakeForzaDisplayPacket, targetMaxSpeed: 300 },
};
