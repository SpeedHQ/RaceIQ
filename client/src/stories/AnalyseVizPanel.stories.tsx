import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { KNOWN_GAME_IDS, type GameId } from "../../../shared/games/ids";
import { useMemo, useRef, useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import { AnalyseTrackPanel } from "../components/analyse/AnalyseTrackPanel";
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
    "tire.temperature.surface.representative": [92, 95, 89, 91],
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
const profileFrame = (offset: number): SemanticAnalysisFrame => ({
  ...frame,
  values: {
    ...frame.values,
    "tire.temperature.surface.inner": [78 + offset, 80 + offset, 82 + offset, 84 + offset],
    "tire.temperature.surface.middle": [92 + offset, 94 + offset, 96 + offset, 98 + offset],
    "tire.temperature.surface.outer": [108 + offset, 110 + offset, 112 + offset, 114 + offset],
    "tire.temperature.core": [88 + offset, 90 + offset, 92 + offset, 94 + offset],
  },
});
const profileFrameOne = profileFrame(0);
const profileFrameTwo: SemanticAnalysisFrame = {
  ...profileFrame(8),
  values: { ...profileFrame(8).values, "tire.temperature.surface.inner": [86, null, 90, 92] },
};
const profileVariantFrame = (variant: "bands" | "core" | "representative"): SemanticAnalysisFrame => {
  const values = { ...profileFrameOne.values };
  if (variant !== "bands") {
    delete values["tire.temperature.surface.inner"];
    delete values["tire.temperature.surface.middle"];
    delete values["tire.temperature.surface.outer"];
  }
  if (variant === "representative") delete values["tire.temperature.core"];
  if (variant === "core") delete values["tire.temperature.surface.representative"];
  return { ...profileFrameOne, values };
};

const profileVariantFrames = {
  bands: profileVariantFrame("bands"),
  core: profileVariantFrame("core"),
  representative: profileVariantFrame("representative"),
} as const;


const telemetry = [frame];
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
const mapLabels = [
  { x: 300, z: 20, text: "T1" },
  { x: -40, z: 180, text: "T2" },
];
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

const meta: Meta<typeof AnalyseVizPanel> = {
  title: "Screens/AnalyseVizPanel",
  component: AnalyseVizPanel,
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
        semanticFrames={telemetry}
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

function ProfileTemperaturesStory() {
  const cursorRef = useRef(0);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [profileEnabled, setProfileEnabled] = useState(true);
  const [vizMode, setVizMode] = useState<"2d" | "3d">("2d");
  cursorRef.current = cursorIdx;
  const selectedFrame = cursorIdx === 0 ? profileFrameOne : profileFrameTwo;
  const frames = [profileFrameOne, profileFrameTwo];
  const displayTelemetryRef = useRef(frames);
  displayTelemetryRef.current = profileEnabled ? frames : [frame, frame];
  return (
    <div className="flex h-screen w-screen flex-col bg-app-bg">
      <div className="flex shrink-0 flex-wrap gap-4 p-2 text-app-text">
        <button type="button" onClick={() => setCursorIdx((index) => index === 0 ? 1 : 0)}>Next frame</button>
        <button type="button" onClick={() => setProfileEnabled((enabled) => !enabled)}>Toggle profile data</button>
        <button type="button" onClick={() => setVizMode(vizMode === "2d" ? "3d" : "2d")}>Switch {vizMode === "2d" ? "3D" : "2D"}</button>

      </div>
      <AnalyseVizPanel
        vizMode={vizMode}
        onVizModeChange={setVizMode}
        currentFrame={profileEnabled ? selectedFrame : frame}
        semanticFrames={profileEnabled ? frames : [frame, frame]}
        displayTelemetryRef={displayTelemetryRef}
        cursorRef={cursorRef}
        cursorIdx={cursorRef.current}
        lapLine={null}
        boundaries={null}
        units={{ tempLabel: "°C", temp: (value: number) => value, thresholds: { cold: 75, warm: 115, hot: 150 } } as never}
        gameId="f1-2025"
      />
    </div>
  );
}

function ProfileVariantStory({ variant, vizMode, gameId = "f1-2025" }: { variant: keyof typeof profileVariantFrames; vizMode: "2d" | "3d"; gameId?: GameId }) {
  const cursorRef = useRef(0);
  const frames = useMemo(() => {
    const selected = profileVariantFrames[variant];
    return [gameId === "iracing" ? {
      ...selected,
      values: { ...selected.values, "tire.temperature.carcass.middle": [88, 90, 92, 94] },
    } : selected];
  }, [variant, gameId]);
  const telemetryRef = useRef(frames);
  telemetryRef.current = frames;
  const variantLabel = variant === "bands" ? "Inner / Middle / Outer + Core" : variant === "core" ? "Core only" : "Representative surface only";
  return (
    <div className="flex h-screen w-screen flex-col bg-app-bg">
      <div className="shrink-0 p-2 font-mono text-xs text-app-text-muted">
        {gameId} · Synthetic profile: {variantLabel} · Rendering fixture, not simulator channel availability
      </div>
      <AnalyseVizPanel
        vizMode={vizMode}
        onVizModeChange={() => {}}
        currentFrame={frames[0]}
        semanticFrames={frames}
        cursorRef={cursorRef}
        displayTelemetryRef={telemetryRef}
        cursorIdx={0}
        lapLine={null}
        boundaries={null}
        units={{ tempLabel: "°C", temp: (value: number) => value, thresholds: { cold: 75, warm: 115, hot: 150 } } as never}
        gameId={gameId}
      />
    </div>
  );
}

export const ProfileTemperatures: Story = {
  render: () => <ProfileTemperaturesStory />,
};
export const ThreeDProfileBands: Story = {
  name: "3D Profile Bands — F1 2025",
  args: { gameId: "f1-2025" },
  argTypes: { gameId: { control: "select", options: KNOWN_GAME_IDS } },
  render: ({ gameId }) => <ProfileVariantStory variant="bands" vizMode="3d" gameId={gameId} />,
};

export const ThreeDProfileBandsForza: Story = {
  ...ThreeDProfileBands,
  name: "3D Profile Bands — Forza Motorsport",
  args: { gameId: "fm-2023" },
};

export const ThreeDProfileBandsACC: Story = {
  ...ThreeDProfileBands,
  name: "3D Profile Bands — ACC",
  args: { gameId: "acc" },
};

export const ThreeDProfileBandsACEvo: Story = {
  ...ThreeDProfileBands,
  name: "3D Profile Bands — AC Evo",
  args: { gameId: "ac-evo" },
};

export const ThreeDProfileBandsIRacing: Story = {
  ...ThreeDProfileBands,
  name: "3D Profile Bands — iRacing",
  args: { gameId: "iracing" },
};

export const ThreeDProfileCoreOnly: Story = {
  render: () => <ProfileVariantStory variant="core" vizMode="3d" gameId="acc" />,
};

export const ThreeDProfileRepresentative: Story = {
  render: () => <ProfileVariantStory variant="representative" vizMode="3d" />,
};

export const TwoDProfileBands: Story = {
  render: () => <ProfileVariantStory variant="bands" vizMode="2d" />,
};

export const TwoDProfileCoreOnly: Story = {
  render: () => <ProfileVariantStory variant="core" vizMode="2d" gameId="acc" />,
};

export const TwoDProfileRepresentative: Story = {
  render: () => <ProfileVariantStory variant="representative" vizMode="2d" />,
};

export const ThreeD: Story = {
  render: () => <ThreeDPanelStory />,
};

export const ThreeDViewMenuOpen: Story = {
  render: () => <ThreeDPanelStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "3D" }));
    await expect(canvas.getByRole("tabpanel", { name: "3D" })).toBeVisible();
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
