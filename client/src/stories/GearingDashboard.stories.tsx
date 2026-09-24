import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { ForzaLiveDashboard } from "../components/ForzaLiveDashboard";
import { defaultTuneSettings } from "../components/tune/form/defaults";
import {
  advancePowerBandRun,
  completePowerBandRun,
  ingestGearingTelemetry,
  resetGearingTelemetry,
  startPowerBandRun,
  trackEffectiveGearing,
  trackTrackSpeedSample,
  type GearingSample,
} from "../lib/gearing-telemetry";
import { gameStore } from "../stores/game";
import { DEFAULT_DISPLAY_SETTINGS, telemetryStore } from "../stores/telemetry";
import { fakeForzaSemanticFixture, fakePit, fakeSectors, fakeSessionLaps } from "./fakeData";
import { LiveDashboardStoryFrame } from "./LiveDashboardStoryFrame";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});

const baseSample = {
  gameId: "fm-2023",
  CarOrdinal: 1742,
  TrackOrdinal: 7,
  sessionUID: fakeForzaSemanticFixture.view.streamId,
  Accel: 255,
  Brake: 0,
  Gear: 4,
  raceActive: true,
  rpm: 6_000,
  EngineMaxRpm: 8_200,
  EngineIdleRpm: 900,
  speedMps: 50,
  AccelerationZ: 0.5,
  powerW: 400_000,
  torqueNm: 500,
  LapNumber: 4,
  DistanceTraveled: 34_000,
} satisfies GearingSample;

const tuneSettings = defaultTuneSettings();
queryClient.setQueryData(["laps", "fm-2023"], fakeSessionLaps);
queryClient.setQueryData(["track-name", 7, "fm-2023"], "Road America");
queryClient.setQueryData(["car-name", 1742, "fm-2023"], "BMW M4");
queryClient.setQueryData(["settings"], DEFAULT_DISPLAY_SETTINGS);
queryClient.setQueryData(["gearing-car-top-speed", "fm-2023", 1742], 186);
queryClient.setQueryData(
  ["user-tunes", "fm-2023"],
  [
    {
      id: 1,
      name: "Road America",
      carOrdinal: 1742,
      settings: {
        ...tuneSettings,
        gearing: {
          ...tuneSettings.gearing,
          finalDrive: 3.42,
          ratios: [3.29, 2.16, 1.61, 1.27, 1.04, 0.88],
          topSpeedKph: 300,
          powerBandMinRpm: 5_200,
          powerBandMaxRpm: 6_450,
        },
      },
    },
  ],
);

function seedGearingData() {
  resetGearingTelemetry();
  startPowerBandRun();
  for (let i = 0; i < 450; i++) {
    const lapNumber = i < 300 ? 3 : 4;
    const lapDist = i < 300 ? (i / 299) * 4_400 : ((i - 300) / 149) * 4_500;
    const speedMps = Math.max(0, 12 + 36 * Math.abs(Math.sin(lapDist / 550)) + 10 * Math.sin(lapDist / 230));
    const packet = {
      ...baseSample,
      Gear: 1 + Math.min(5, Math.floor(lapDist / 800)),
      rpm: 4_500 + (i % 40) * 50,
      speedMps,
      powerW: 280_000 + (i % 20) * 10_000,
      torqueNm: 350 + (i % 10) * 5,
      LapNumber: lapNumber,
      DistanceTraveled: lapNumber * 10_000 + lapDist,
    };
    trackTrackSpeedSample(packet);
    if (advancePowerBandRun(packet) === "record") ingestGearingTelemetry(packet);
  }
  const redlineSpeedsKph = [80, 122, 164, 208, 254, 300];
  redlineSpeedsKph.forEach((redlineSpeedKph, index) => {
    const rpmPerMps = baseSample.EngineMaxRpm / (redlineSpeedKph / 3.6);
    for (let sample = 0; sample < 25; sample++) {
      const rpm = 3_000 + sample * 180;
      trackEffectiveGearing({ ...baseSample, Gear: index + 1, rpm, speedMps: rpm / rpmPerMps });
    }
  });
  completePowerBandRun();
}

function StoryDecorator({ story: Story }: { story: ComponentType }) {
  seedGearingData();
  const { schema, frame, view } = fakeForzaSemanticFixture;
  telemetryStore.setState((previous) => ({
    ...previous,
    connected: true,
    telemetrySchema: schema,
    telemetryFrame: frame,
    telemetryView: {
      ...view,
      identity: { ...view.identity, carOrdinal: baseSample.CarOrdinal, trackOrdinal: baseSample.TrackOrdinal },
      motion: { ...view.motion, speedMps: baseSample.speedMps, distanceM: baseSample.DistanceTraveled, acceleration: { x: 0, z: baseSample.AccelerationZ } },
      inputs: { ...view.inputs, throttle: baseSample.Accel, brake: baseSample.Brake, gear: baseSample.Gear },
      engine: {
        ...view.engine,
        rpm: baseSample.rpm,
        idleRpm: baseSample.EngineIdleRpm,
        maxRpm: baseSample.EngineMaxRpm,
        powerW: baseSample.powerW,
        torqueNm: baseSample.torqueNm,
      },
      timing: { ...view.timing, lapNumber: baseSample.LapNumber },
      race: { ...view.race, isRaceOn: true },
    },
    sectors: fakeSectors,
    pit: fakePit,
    sessionLaps: fakeSessionLaps,
    isRaceOn: true,
    udpPps: 60,
    packetsPerSec: 60,
    unitSystem: "metric",
    serverStatus: {
      udpPps: 60,
      telemetryPps: 60,
      isRaceOn: true,
      droppedPackets: 0,
      udpPort: 5300,
      detectedGame: { id: "fm-2023", name: "Forza Motorsport" },
      currentSession: { id: 2, carOrdinal: baseSample.CarOrdinal, trackOrdinal: baseSample.TrackOrdinal },
    },
  }));
  gameStore.setState((previous) => ({ ...previous, gameId: "fm-2023" }));

  return <LiveDashboardStoryFrame queryClient={queryClient} story={Story} />;
}

const meta: Meta<typeof ForzaLiveDashboard> = {
  title: "Dashboards/GearingDashboard",
  component: ForzaLiveDashboard,
  decorators: [(Story) => <StoryDecorator story={Story} />],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof ForzaLiveDashboard>;

export const WithLapTrace: Story = {
  args: { mode: "gearing" },
};
