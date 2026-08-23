import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { LiveTestDashboard } from "../components/tunes/LiveTestDashboard";
import { useTelemetryStore } from "../stores/telemetry";
import { fakeAccSemanticFixture, fakeSectors, fakeSessionLaps } from "./fakeData";
import { fakeSectorTimes, fakeTuneIssues, generateFakeLapTelemetry } from "./setupEngineerFakeLap";
import type { LiveTelemetryView } from "../lib/live-telemetry-view";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

// Simple oval outline so the track position panel has something to draw.
// NOTE: AnalyseTrackMap's Point type is { x, z } (not { x, y }) — using `y`
// makes minZ/maxZ NaN and the track renders as nothing (black panel).
const fakeOutline = Array.from({ length: 64 }, (_, i) => {
  const t = (i / 64) * Math.PI * 2;
  return { x: Math.cos(t) * 400, z: Math.sin(t) * 200 };
});
queryClient.setQueryData(["track-outline", 7, "acc"], fakeOutline);
queryClient.setQueryData(["track-boundaries", 7, "acc"], null);

// Full lap trace so the live tyre bars have a real min→max range to render, not a single point.
const liveTrace = generateFakeLapTelemetry();
const liveViews: LiveTelemetryView[] = liveTrace.map((packet, index) => ({
  ...fakeAccSemanticFixture.view,
  sequence: index,
  observedAtMs: packet.TimestampMS,
  identity: {
    ...fakeAccSemanticFixture.view.identity,
    trackOrdinal: packet.TrackOrdinal,
    carOrdinal: packet.CarOrdinal,
  },
  motion: {
    ...fakeAccSemanticFixture.view.motion,
    speedMps: packet.Speed,
    distanceM: packet.DistanceTraveled,
    position: { x: packet.PositionX, z: packet.PositionZ },
    attitude: { roll: packet.Roll, pitch: packet.Pitch, yaw: packet.Yaw },
  },
  inputs: { throttle: packet.Accel, brake: packet.Brake, steer: packet.Steer, gear: packet.Gear },
  engine: { ...fakeAccSemanticFixture.view.engine, rpm: packet.CurrentEngineRpm },
  fuel: { amount: packet.Fuel, capacity: packet.FuelCapacity },
  timing: {
    ...fakeAccSemanticFixture.view.timing,
    lapNumber: packet.LapNumber,
    currentLapS: packet.CurrentLap,
  },
  tires: {
    ...fakeAccSemanticFixture.view.tires,
    temperatureC: { fl: packet.TireTempFL, fr: packet.TireTempFR, rl: packet.TireTempRL, rr: packet.TireTempRR },
    wear: { fl: packet.TireWearFL, fr: packet.TireWearFR, rl: packet.TireWearRL, rr: packet.TireWearRR },
    pressurePsi: { fl: packet.TirePressureFrontLeft, fr: packet.TirePressureFrontRight, rl: packet.TirePressureRearLeft, rr: packet.TirePressureRearRight },
    brakeTemperatureC: { fl: packet.BrakeTempFrontLeft, fr: packet.BrakeTempFrontRight, rl: packet.BrakeTempRearLeft, rr: packet.BrakeTempRearRight },
  },
}));
queryClient.setQueryData(["lap-telemetry", 10], { telemetry: liveTrace, sectorTimes: fakeSectorTimes });

function StoryDecorator({ children, animate }: { children: React.ReactNode; animate: boolean }) {
  // Seed the store once on mount. Doing this in the render body sets state with
  // fresh object refs every render, which re-triggers subscribers → infinite
  // "Maximum update depth exceeded" loop (and a UI that never stops updating).
  useEffect(() => {
    useTelemetryStore.setState({
      connected: true,
      // Last frame of the pre-seeded lap so appending it doesn't reset the trace.
      telemetryView: liveViews.at(-1) ?? fakeAccSemanticFixture.view,
      sectors: fakeSectors,
      sessionLaps: fakeSessionLaps,
      isRaceOn: true,
      lapIssuesFeed: [{ lapId: 10, lapNumber: 4, issues: fakeTuneIssues }],
    });
  }, []);

  // `animate` Storybook control replays the lap continuously (off by default).
  useEffect(() => {
    if (!animate) return;
    let i = 0;
    const id = setInterval(() => {
      i = (i + 1) % liveTrace.length;
      useTelemetryStore.setState({ telemetryView: liveViews[i] });
    }, 50);
    return () => clearInterval(id);
  }, [animate]);

  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ height: "100vh", overflow: "hidden", background: "var(--app-bg)" }}>{children}</div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof LiveTestDashboard & { animate: boolean }> = {
  title: "Dashboards/Experiments/LiveTestDashboard",
  component: LiveTestDashboard,
  argTypes: {
    // @ts-expect-error — story-only control, not a LiveTestDashboard prop
    animate: { control: "boolean", description: "Replay the fake lap continuously" },
  },
  decorators: [
    // @ts-expect-error — animate is a story-only arg, not a component prop
    (Story, ctx) => (
      <StoryDecorator animate={Boolean(ctx.args.animate)}>
        <Story />
      </StoryDecorator>
    ),
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof LiveTestDashboard>;

export const Default: Story = {
  // @ts-expect-error — animate is a story-only arg, not a component prop
  args: { gameId: "acc", trackOrdinal: 7, initialViews: liveViews, animate: false },
};
