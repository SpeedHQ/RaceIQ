import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AnalyseDataPanel } from "../components/analyse/AnalyseDataPanel";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";
import type { FindingRecord } from "../../../shared/racing/findings/types";

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
    "tire.temperature.average": [90, 91, 92, 93],
    "brakes.brake-temp": [500, 510, 300, 310],
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
const finding: FindingRecord = {
  schemaVersion: "1",
  id: "story-fuel-per-lap",
  type: "fuel-per-lap",
  category: "fuel",
  scope: {
    kind: "lap",
    gameId: "f1-2025",
    sessionId: "42",
    lapId: "7",
  },
  status: "available",
  severity: "informational",
  confidence: "high",
  measurements: [{
    id: "fuel-per-lap",
    type: "fuel-per-lap",
    value: 2.4,
    unit: "L",
    sampleCount: 240,
    confidence: "high",
    semanticIds: ["fuel.fuel-level"],
    derivation: { id: "lap-metrics-adapter", version: "1" },
  }],
  evidenceRefs: [{
    kind: "telemetry-range",
    id: "fuel-range",
    lapId: "7",
    startFrameIndex: 20,
    endFrameIndex: 220,
    channel: "fuel.fuel-level",
  }],
  qualityRefs: [],
  limitations: [],
  rule: { id: "lap-metrics-adapter", version: "1", inputs: {} },
  analysisGenerationId: "story-generation",
  title: "Fuel used per lap",
};


const meta: Meta<typeof AnalyseDataPanel> = {
  title: "Screens/AnalyseDataPanelParity",
  component: AnalyseDataPanel,
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "1080p" } },
  decorators: [(Story) => <QueryClientProvider client={queryClient}><Story /></QueryClientProvider>],
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
      toTempC: (value: number) => value,
    } as never,
    wearRate: { FL: 0.1, FR: 0.2, RL: 0.3, RR: 0.4 },
    findings: [],
    onEvidenceSelect: () => {},
  },
};

export const FindingsParity: Story = {
  args: {
    ...LoadedMainParity.args,
    sidebarTab: "insights",
    findings: [finding],
  },
};
