import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import type { ComponentType, ReactNode } from "react";
import { LapAnalyse } from "@/components/analyse/LapAnalyse";
import type { SemanticLapTelemetry } from "@/hooks/laps";
import type { LapMeta } from "../../../shared/racing/sessions/types";
import { GameStoryScope } from "./GameStoryScope";

const GAME_ID = "fm-2023" as const;
const LAP_ID = 920;
const CAR_ORDINAL = 201;
const TRACK_ORDINAL = 1641;

const outline = Array.from({ length: 80 }, (_, index) => {
  const angle = (index / 80) * Math.PI * 2;
  return { x: Math.cos(angle) * 1200, z: Math.sin(angle) * 700 };
});

const laps: LapMeta[] = [
  {
    id: LAP_ID,
    sessionId: 9001,
    lapNumber: 12,
    lapTime: 95.844,
    isValid: true,
    createdAt: "2026-07-28T18:45:00.000Z",
    gameId: GAME_ID,
    carOrdinal: CAR_ORDINAL,
    trackOrdinal: TRACK_ORDINAL,
    sectorTimes: [31.781, 32.044, 31.812],
  },
  {
    id: 919,
    sessionId: 9001,
    lapNumber: 11,
    lapTime: 96.108,
    isValid: true,
    createdAt: "2026-07-28T18:43:00.000Z",
    gameId: GAME_ID,
    carOrdinal: CAR_ORDINAL,
    trackOrdinal: TRACK_ORDINAL,
  },
];

function makeFrame(index: number) {
  const distance = index / 29;
  const speed = 170 + Math.sin(index / 3) * 35;
  const wear = 0.05 + index / 29_000;
  return {
    sequence: index,
    observedAt: { domain: "simulator", milliseconds: index * 3_300 },
    receivedAt: { domain: "server", milliseconds: index * 3_300 },
    simulator: GAME_ID,
    values: [
      { semanticId: "motion.speed", value: speed },
      { semanticId: "motion.position-x", value: outline[index * 2]?.x ?? 0 },
      { semanticId: "motion.position-z", value: outline[index * 2]?.z ?? 0 },
      { semanticId: "timing.current-lap", value: (index / 29) * 95.844 },
      { semanticId: "timing.distance-traveled", value: distance },
      { semanticId: "engine.current-engine-rpm", value: 8_500 + Math.sin(index / 2) * 1_800 },
      { semanticId: "inputs.gear", value: Math.max(2, Math.round(5 + Math.sin(index / 4) * 2)) },
      { semanticId: "inputs.accel", value: Math.max(0, 80 + Math.sin(index / 3) * 25) },
      { semanticId: "inputs.brake", value: Math.max(0, 20 + Math.sin(index / 2) * 18) },
      { semanticId: "inputs.steer", value: Math.sin(index / 4) * 30 },
      { semanticId: "engine.boost", value: 0.3 },
      { semanticId: "engine.power", value: 650_000 },
      { semanticId: "fuel.fuel", value: 0.82 - index / 500 },
      { semanticId: "fuel.fuel-capacity", value: 1 },
      { semanticId: "motion.acceleration-x", value: Math.sin(index / 3) * 3 },
      { semanticId: "motion.acceleration-z", value: 9.81 },
      { semanticId: "motion.angular-velocity-y", value: Math.cos(index / 3) * 0.2 },
      { semanticId: "tires.tire-combined-slip", value: [0.2, 0.3, 0.25, 0.35] },
      { semanticId: "tires.tire-slip-ratio", value: [0.1, 0.2, 0.1, 0.2] },
      { semanticId: "tires.tire-slip-angle", value: [0.01, 0.02, 0.01, 0.02] },
      { semanticId: "tire.temperature.average", value: [88, 90, 87, 89] },
      { semanticId: "brakes.brake-temp", value: [480, 490, 300, 310] },
      { semanticId: "tires.wheel-rotation-speed", value: [100, 101, 100, 101] },
      { semanticId: "tires.tire-wear", value: [wear, wear + 0.01, wear + 0.02, wear + 0.015] },
      { semanticId: "tires.tire-pressure", value: [24, 24.2, 23.8, 24.1] },
      { semanticId: "suspension.suspension-travel-m", value: [0.02, 0.03, 0.02, 0.03] },
      { semanticId: "identity.car-ordinal", value: CAR_ORDINAL },
    ],
  };
}

const semanticReplay: SemanticLapTelemetry = {
  lapId: LAP_ID,
  requestedSemanticIds: [],
  sectorStarts: [0, 1 / 3, 2 / 3],
  sectorTimes: [31.781, 32.044, 31.812],
  insights: [],
  envelopes: Array.from({ length: 30 }, (_, index) => makeFrame(index)),
};

function createQueryClient() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  queryClient.setQueryData(["laps", GAME_ID], laps);
  queryClient.setQueryData(["lap-semantic-telemetry", LAP_ID, GAME_ID], semanticReplay);
  queryClient.setQueryData(["track-name", TRACK_ORDINAL, GAME_ID], "Hakone Club");
  queryClient.setQueryData(["car-name", CAR_ORDINAL, GAME_ID], "2023 Cadillac V-Series.R");
  queryClient.setQueryData(["track-outline", TRACK_ORDINAL, GAME_ID], { points: outline, source: "storybook" });
  queryClient.setQueryData(["track-boundaries", TRACK_ORDINAL, GAME_ID], null);
  queryClient.setQueryData(["track-sector-boundaries", TRACK_ORDINAL, GAME_ID], { s1End: 1 / 3, s2End: 2 / 3 });
  queryClient.setQueryData(["track-sectors", TRACK_ORDINAL, GAME_ID], { segments: [] });
  queryClient.setQueryData(["tunes", CAR_ORDINAL], []);
  return queryClient;
}

function StoryProviders({ Story }: { Story: ComponentType }) {
  const queryClient = createQueryClient();
  const rootRoute = createRootRoute({ component: Story });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/${GAME_ID}/analyse?track=${TRACK_ORDINAL}&car=${CAR_ORDINAL}&lap=${LAP_ID}`] }),
  });
  return (
    <GameStoryScope gameId={GAME_ID}>
      <QueryClientProvider client={queryClient}>
        <div style={{ height: "100vh", overflow: "hidden", background: "var(--app-bg)" }}>
          <RouterProvider router={router} />
        </div>
      </QueryClientProvider>
    </GameStoryScope>
  );
}

const meta = {
  title: "Pages/Analyse Session",
  component: LapAnalyse,
  decorators: [(Story) => <StoryProviders Story={Story} />],
  parameters: { layout: "fullscreen", viewport: { defaultViewport: "1080p" } },
} satisfies Meta<typeof LapAnalyse>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loaded: Story = {};
