import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnalyseDataPanel } from "../components/analyse/AnalyseDataPanel";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";

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
    "identity.car-ordinal": 1,
    "fuel.ers-store-energy": 2_000_000,
    "fuel.ers-deployed": 400_000,
    "fuel.ers-harvested": 200_000,
    "fuel.ers-deploy-mode": "4",
    "aero.drs-active": true,
  },
  states: {},
  freshness: {},
};

const meta: Meta<typeof AnalyseDataPanel> = {
  title: "Screens/AnalyseDataPanelParity",
  component: AnalyseDataPanel,
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "1080p" } },
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <Story />
      </QueryClientProvider>
    ),
  ],
};
export default meta;
type Story = StoryObj<typeof AnalyseDataPanel>;

export const LoadedMainParity: Story = {
  args: {
    sidebarTab: "live",
    onSidebarTabChange: () => {},
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
    lapInsights: [],
    detectorCoverage: [],
    onJumpToFrame: () => {},
  },
};
export const DetectorCoverage: Story = {
  ...LoadedMainParity,
  args: {
    ...LoadedMainParity.args,
    sidebarTab: "insights",
    lapInsights: [{ id: "tire-lockup-FL", category: "tires", severity: "warning", label: "Wheel Lockup", detail: "FL locked once", frameIndices: [25] }],
    detectorCoverage: [
      { id: "tire-lockup", category: "tires", label: "Wheel Lockup", status: "finding" },
      { id: "tire-spin", category: "tires", label: "Wheelspin", status: "checked" },
      { id: "driving-traction-control-activation", category: "driving", label: "Traction Control Activation", status: "unavailable", reason: "Wheel-rotation telemetry unavailable" },
    ],
  },
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
