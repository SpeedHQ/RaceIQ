import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnalyseDataContent } from "../components/analyse/AnalyseDataPanel";
import { InsightPanel } from "@raceiq/lap-replay/ui";
import { LapReplayHostProvider } from "../features/lap-replay-host";
import type { SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
const frame: SemanticAnalysisFrame = {
  values: {
    "motion.speed": 30,
    "engine.current-engine-rpm": 12000,
    "inputs.gear": 7,
    "inputs.accel": 204,
    "inputs.brake": 51,
    "inputs.steer": -32,
    "engine.boost": 0.4,
    "engine.power": 745700,
    "fuel.fuel": 0.42,
    "fuel.fuel-capacity": 1,
    "motion.acceleration-x": 4.905,
    "motion.acceleration-z": 9.81,
    "motion.angular-velocity-y": 0.2,
    "tires.tire-combined-slip": [0.2, 0.4, 0.6, 0.8],
    "tires.tire-slip-ratio": [0.1, 0.2, 0.3, 0.4],
    "tires.tire-slip-angle": [0.01, 0.02, 0.03, 0.04],
    "tire.temperature.surface.representative": [90, 91, 92, 93],
    "tire.temperature.surface.inner": [84, 85, 86, 87],
    "tire.temperature.surface.middle": [92, 93, 94, 95],
    "tire.temperature.surface.outer": [101, 102, 103, 104],
    "tire.temperature.core": [88, 89, 90, 91],
    "tires.wheel-rotation-speed": [100, 101, 102, 103],
    "tires.tire-wear": [0.1, 0.2, 0.3, 0.4],
    "tires.tire-pressure": [24, 24.5, 23.5, 24],
    "suspension.suspension-travel-m": [0.02, 0.04, 0.06, 0.08],
    "identity.car-id": "1",
    "fuel.ers-store-energy": 2_000_000,
    "fuel.ers-deployed": 400_000,
    "fuel.ers-harvested": 200_000,
    "fuel.ers-deploy-mode": "4",
    "aero.drs-active": true,
  },
  states: {},
  freshness: {},
};

const meta: Meta<typeof AnalyseDataContent> = {
  title: "Screens/AnalyseDataPanelParity",
  component: AnalyseDataContent,
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "1080p" } },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <LapReplayHostProvider><div className="flex h-screen w-[22rem] flex-col overflow-y-auto"><Story /></div></LapReplayHostProvider>
      </QueryClientProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AnalyseDataContent>;

export const LoadedMainParity: Story = {
  args: {
    packetNumber: 1,
    currentFrame: frame,
    startFuel: 0.8,
    gameId: "f1-2025",
    units: {
      speed: (value: number) => value * 2.23694,
      speedLabel: "mph",
      tempLabel: "°C",
      temperatureUnit: "C",
      thresholds: { cold: 75, warm: 115, hot: 150 },
      temp: (value: number) => value,
    } as never,
    wearRate: { FL: 0.1, FR: 0.2, RL: 0.3, RR: 0.4 },
  },
};
export const DetectorCoverage: Story = {
  render: () => <InsightPanel
    insights={[{ id: "tire-lockup-FL", category: "tires", severity: "warning", label: "Wheel Lockup", detail: "FL locked once", frameIndices: [25] }]}
    detectorCoverage={[
      { id: "tire-lockup", category: "tires", label: "Wheel Lockup", status: "finding" },
      { id: "tire-spin", category: "tires", label: "Wheelspin", status: "checked" },
      { id: "driving-traction-control-activation", category: "driving", label: "Traction Control Activation", status: "unavailable", reason: "Wheel-rotation telemetry unavailable" },
    ]}
    onJumpToFrame={() => {}}
  />,
};

export const LMUTireTemperatures: Story = {
  ...LoadedMainParity,
  args: {
    ...LoadedMainParity.args,
    gameId: "lmu",
    currentFrame: {
      ...frame,
      values: {
        ...frame.values,
        "tire.temperature.carcass.representative": [88, 89, 90, 91],
        "tire.temperature.core": undefined,
      },
    },
  },
};

export const LMUElectronics: Story = {
  ...LMUTireTemperatures,
  args: {
    ...LMUTireTemperatures.args,
    currentFrame: {
      ...LMUTireTemperatures.args!.currentFrame!,
      values: {
        ...LMUTireTemperatures.args!.currentFrame!.values,
        "electronics.traction-control-level": 4,
        "electronics.abs-level": 3,
        "electronics.tc-active": true,
        "electronics.abs-active": false,
        "electronics.tc-cut-level": 0,
        "electronics.motor-map": 2,
        "brakes.brake-bias": 0.56,
        "diagnostics.migration": 3,
        "fuel.state-of-charge": 72,
        "fuel.virtual-energy": 0.63,
        "diagnostics.regen-kw": -80,
      },
    },
  },
};

export const LMUElectronicsUnavailable: Story = {
  ...LMUElectronics,
  args: {
    ...LMUElectronics.args,
    currentFrame: {
      ...LMUElectronics.args!.currentFrame!,
      states: {
        "electronics.traction-control-level": "missing",
        "electronics.abs-level": "invalid",
        "electronics.tc-active": "not-applicable",
        "diagnostics.migration": "missing",
        "fuel.state-of-charge": "invalid",
      },
      freshness: {
        "electronics.abs-active": "stale",
        "electronics.tc-cut-level": "stale",
        "electronics.motor-map": "stale",
        "fuel.virtual-energy": "stale",
        "diagnostics.regen-kw": "stale",
      },
    },
  },
};

export const LMUEnergyZero: Story = {
  ...LMUElectronics,
  args: {
    ...LMUElectronics.args,
    currentFrame: {
      ...LMUElectronics.args!.currentFrame!,
      values: {
        ...LMUElectronics.args!.currentFrame!.values,
        "diagnostics.migration": 0,
        "fuel.state-of-charge": 0,
        "fuel.virtual-energy": 0,
        "diagnostics.regen-kw": 0,
      },
    },
  },
};
