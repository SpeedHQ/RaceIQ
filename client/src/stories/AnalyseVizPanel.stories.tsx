import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { expect, userEvent, within } from "storybook/test";
import { AnalyseTrackPanel } from "../components/analyse/AnalyseTrackPanel";
import { AnalyseVizPanel } from "../components/analyse/AnalyseVizPanel";
import type { SemanticAnalysisFrame } from "../components/analyse/track-map/types";

export const frame: SemanticAnalysisFrame = {
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
    "weather.air-temp": 24,
    "weather.track-temp": 34,
    "weather.rain-percent": 0,
  },
  states: {},
  freshness: {},
};

export const telemetry = [frame];
const trackOutline = Array.from({ length: 96 }, (_, index) => {
  const angle = (index / 96) * Math.PI * 2;
  return { x: Math.cos(angle) * 420, z: Math.sin(angle) * 240 };
});
const trackBoundaries = {
  leftEdge: trackOutline.map((point) => ({ x: point.x * 0.92, z: point.z * 0.92 })),
  rightEdge: trackOutline.map((point) => ({ x: point.x * 1.08, z: point.z * 1.08 })),
  centerLine: trackOutline,
  raceLine: trackOutline.map((point) => ({ x: point.x * 1.01, z: point.z * 1.01 })),
  pitLane: null,
  coordSystem: "storybook",
};
const sectorBoundaries = { sectorStarts: [0, 0.33, 0.66], sectorCount: 3 };
const segments = [
  { type: "corner", name: "Turn 1", startFrac: 0.08, endFrac: 0.16 },
  { type: "straight", name: "Back straight", startFrac: 0.42, endFrac: 0.58 },
];
const mapLabels = [{ x: 300, z: 20, text: "T1" }, { x: -40, z: 180, text: "T2" }];
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

export const ThreeDViewMenuOpen: Story = {
  render: () => <ThreeDPanelStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /view/i }));
    const body = within(document.body);
    await expect(await body.findByRole("menu")).toBeVisible();
  },
};

export const TrackDisplay: Story = {
  render: () => (
    <div className="h-screen w-screen bg-app-bg">
      <AnalyseTrackPanel
        gameId="f1-2025"
        telemetry={telemetry}
        cursorIdx={0}
        outline={trackOutline}
        mapLabels={mapLabels}
        boundaries={trackBoundaries}
        sectors={sectorBoundaries}
        segments={segments}
        currentFrame={frame}
        rotateWithCar={false}
        trackOverlays={{ inputs: true, segments: true, sectors: true, racingLine: true }}
        mapZoom={1}
        onRotateWithCarToggle={() => {}}
        onTrackOverlayChange={() => {}}
        onMapZoomChange={() => {}}
      />
    </div>
  ),
};
