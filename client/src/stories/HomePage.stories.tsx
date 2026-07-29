import type { LapMeta, SessionMeta, SessionRecap } from "@shared/types";
import type { DriverFingerprint } from "../../../server/ai/driver-profile-aggregate";
import type { DriverProfileRun } from "../hooks/queries";

import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { HomePage } from "../components/HomePage";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
import { useGameStore } from "../stores/game";

const GAME_ID = "fm-2023" as const;
const SESSION_ID = 9001;

function makeLap(id: number, day: number, lapNumber: number, lapTime: number, isValid = true): LapMeta {
  return {
    id,
    sessionId: SESSION_ID,
    lapNumber,
    lapTime,
    isValid,
    createdAt: `2026-07-${String(day).padStart(2, "0")}T18:2${lapNumber}:00.000Z`,
    gameId: GAME_ID,
    carOrdinal: 201,
    trackOrdinal: 42,
  };
}

const laps: LapMeta[] = [
  makeLap(910, 19, 1, 98.742),
  makeLap(911, 20, 2, 97.928),
  makeLap(912, 21, 3, 97.514),
  makeLap(913, 22, 4, 96.981),
  makeLap(914, 23, 5, 97.204),
  makeLap(915, 24, 6, 96.731),
  makeLap(916, 25, 7, 96.884),
  makeLap(917, 26, 8, 96.552),
  makeLap(918, 27, 9, 96.319),
  makeLap(919, 28, 10, 96.108),
  makeLap(920, 28, 11, 95.844),
  makeLap(921, 28, 12, 97.632, false),
];

const sessions: SessionMeta[] = [
  {
    id: SESSION_ID,
    carOrdinal: 201,
    trackOrdinal: 42,
    createdAt: "2026-07-28T18:45:00.000Z",
    lapCount: laps.length,
    bestLapTime: 95.844,
    sessionType: "Practice",
    gameId: GAME_ID,
  },
];

const recap: SessionRecap = {
  sessionId: SESSION_ID,
  gameId: GAME_ID,
  carName: "2023 Cadillac V-Series.R",
  trackName: "Hakone Club",
  carOrdinal: 201,
  trackOrdinal: 42,
  createdAt: "2026-07-28T18:45:00.000Z",
  lapsValid: 11,
  lapsTotal: 12,
  bestLapSec: 95.844,
  bestLapId: 920,
  timeOnTrackSec: 1068.419,
  distanceM: 11_880,
  sparkline: laps.map((lap) => ({ lapNumber: lap.lapNumber, lapTimeSec: lap.lapTime, isValid: lap.isValid })),
  theoretical: {
    bestSectorTimes: [31.781, 32.044, 31.812],
    sumSec: 95.637,
    deltaToBestSec: 0.207,
  },
  sectorStarts: null,
  improvementSec: 2.898,
  consistency: { stdDevSec: 0.642, rating: 4 },
  personalBest: { isNew: true, previousBestSec: 96.201 },
  sectors: null,
};

const DRIVER_FINGERPRINT: DriverFingerprint = {
  ok: true,
  scope: { kind: "car-track", gameId: GAME_ID, carOrdinal: 201, trackOrdinal: 42 },
  laps: { lapIds: laps.map((lap) => lap.id), analyzed: 12, candidates: 12, droppedInvalid: 1, droppedOutlier: 0, droppedByCap: 0, droppedNoTelemetry: 0 },
  confidence: "high",
  style: {
    gripUtilMedian: 0.78,
    gripUtilP95: 0.96,
    balanceMedianDeg: 1.8,
    understeerFraction: 0.21,
    oversteerFraction: 0.08,
    controlLossFraction: 0.01,
    steerReversalsPerS: 1.1,
    slipVariabilityDeg: 0.9,
    brakingStyle: -24,
    consistency: 86,
    physicsLaps: 12,
  },
  pace: { consistency: 86, sdS: 0.64, bestS: 95.844, meanS: 96.82, degSlopeSPerLap: -0.12, n: 12, basis: "single-context", contexts: 1 },
  weaknesses: [
    {
      id: "driving-early-braking",
      category: "driving",
      label: "Early braking",
      perLapFrequency: 0.42,
      lapsAffected: 5,
      meanSeverityWeight: 1.4,
      peakSeverity: "warning",
      medianTimeLossS: 0.18,
      lapsQuantified: 5,
      sampleDetail: "Brake point arrives early into the hairpin.",
      score: 0.08,
      timeLossKnown: true,
    },
  ],
  unquantifiedWeaknesses: [],
  strengths: [{ id: "driving-late-braking-overshoot", label: "Stable braking", perLapFrequency: 0.08, basis: "rare" }],
  detectors: [],
  notes: ["Fixed Storybook fixture."],
};

const PROFILE_RUN: DriverProfileRun = {
  id: 7001,
  scopeKey: "fm-2023:global",
  gameId: GAME_ID,
  carOrdinal: null,
  trackOrdinal: null,
  poolKey: "fm-2023:global",
  status: "succeeded",
  fingerprint: JSON.stringify(DRIVER_FINGERPRINT),
  plan: null,
  error: null,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  durationMs: 420,
  model: "storybook-fixture",
  createdAt: "2026-07-28T19:00:00.000Z",
  startedAt: "2026-07-28T18:59:00.000Z",
  completedAt: "2026-07-28T19:00:00.000Z",
};

function createQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });

  queryClient.setQueryData(["laps", GAME_ID], laps);
  queryClient.setQueryData(["sessions", GAME_ID], sessions);
  queryClient.setQueryData(["settings"], { ...DEFAULT_DISPLAY_SETTINGS, driverName: "Alex", hiddenGames: [] });
  queryClient.setQueryData(["session-recap", SESSION_ID, GAME_ID], recap);
  queryClient.setQueryData(["driver-profile", GAME_ID, null, null], {
    fingerprint: DRIVER_FINGERPRINT,
    gameName: "Forza Motorsport 2023",
    carName: "2023 Cadillac V-Series.R",
    trackName: "Hakone Club",
    selectedLapTimes: laps.map((lap) => ({ id: lap.id, lapTime: lap.lapTime, isValid: lap.isValid })),
  });
  queryClient.setQueryData(["driver-profile-runs", GAME_ID, null, null], {
    scope: { gameId: GAME_ID },
    state: "succeeded",
    enabled: true,
    configured: true,
    latest: PROFILE_RUN,
    runs: [PROFILE_RUN],
  });

  for (const [gameId, totalLaps, totalTimeSec] of [
    ["fm-2023", 128, 12_480],
    ["f1-2025", 74, 7_215],
    ["acc", 52, 5_086],
    ["ac-evo", 31, 3_042],
    ["iracing", 18, 1_764],
  ] as const) {
    queryClient.setQueryData(["stats", gameId], { totalLaps, totalTimeSec });
  }

  return queryClient;
}

const originalFetch = window.fetch.bind(window);
const carNames: Record<string, string> = { "201": "2023 Cadillac V-Series.R" };
const trackNames: Record<string, string> = { "42": "Hakone Club" };

function mockNameFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const carMatch = url.match(/\/api\/car-name\/(\d+)/);
  if (carMatch) return Promise.resolve(new Response(carNames[carMatch[1]] ?? "Unknown car", { status: 200 }));
  const trackMatch = url.match(/\/api\/track-name\/(\d+)/);
  if (trackMatch) return Promise.resolve(new Response(trackNames[trackMatch[1]] ?? "Unknown track", { status: 200 }));
  return originalFetch(input, init);
}

/** Installs only the two name endpoints HomePage resolves outside TanStack Query. */
function MockHomeApi({ children }: { children: ReactNode }) {
  const restored = useRef(false);
  if (!restored.current) {
    window.fetch = mockNameFetch;
    restored.current = true;
  }
  useEffect(() => () => {
    window.fetch = originalFetch;
  }, []);
  return children;
}

function StoryProviders({ Story }: { Story: ComponentType }) {
  // Set the active game while the provider tree is rendering so HomePage's
  // first query/render is scoped to the deterministic Forza fixture.
  useGameStore.getState().setGameId(GAME_ID);
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => {
    const rootRoute = createRootRoute({ component: Story });
    return createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/fm23"] }) });
  });
  return (
    <MockHomeApi>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </MockHomeApi>
  );
}

function withProviders(Story: ComponentType) {
  return <StoryProviders Story={Story} />;
}

const meta = {
  title: "Dashboards/Home Dashboard",
  component: HomePage,
  decorators: [(Story) => withProviders(Story)],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The actual per-game home surface with deterministic profile, activity, stats, laps, and session fixtures. */
export const PerGame: Story = {};
