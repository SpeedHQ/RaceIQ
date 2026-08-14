import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { AnalyseVizPanel } from "../components/analyse/AnalyseVizPanel";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";

const frame: SemanticAnalysisFrame = {
  values: {
    "identity.car-ordinal": 1,
    "motion.speed": 58,
    "motion.position-x": 120,
    "motion.position-z": 240,
    "motion.roll": 0.02,
    "motion.pitch": -0.01,
    "motion.yaw": 1.1,
    "inputs.gear": 6,
    "inputs.accel": 0.82,
    "inputs.brake": 0,
    "inputs.steer": -0.12,
    "engine.current-engine-rpm": 10_800,
    "engine.engine-max-rpm": 14_000,
    "engine.power": 520_000,
    "fuel.fuel": 0.62,
    "fuel.fuel-capacity": 1,
    "tire.temperature.average": [92, 95, 89, 91],
    "tires.tire-pressure": [25.1, 25.3, 24.8, 25],
    "tires.tire-wear": [0.12, 0.1, 0.14, 0.11],
    "brakes.brake-temp": [430, 440, 370, 375],
    "aero.drs-active": true,
  },
  states: {},
  freshness: {},
};

const telemetry = [frame];
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

const meta: Meta<typeof AnalyseVizPanel> = {
  title: "Screens/AnalyseVizPanel",
  component: AnalyseVizPanel,
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "1080p" } },
  decorators: [(Story) => <QueryClientProvider client={queryClient}><Story /></QueryClientProvider>],
};

export default meta;
type Story = StoryObj<typeof AnalyseVizPanel>;

function ThreeDPanelStory() {
  const cursorRef = useRef(0);
  const telemetryRef = useRef(telemetry);

  return (
    <div className="h-screen w-screen bg-app-bg">
      <AnalyseVizPanel
        vizMode="3d"
        onVizModeChange={() => {}}
        currentFrame={frame}
        displayTelemetry={telemetry}
        cursorRef={cursorRef}
        displayTelemetryRef={telemetryRef}
        cursorIdx={0}
        lapLine={null}
        boundaries={null}
        units={{ tempLabel: "°C" } as never}
        gameId="f1-2025"
      />
    </div>
  );
}

export const ThreeD: Story = {
  render: () => <ThreeDPanelStory />,
};
