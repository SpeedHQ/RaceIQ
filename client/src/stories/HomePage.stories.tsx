import type { Meta, StoryObj } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import type { DriverFingerprint } from "../../../server/driver-profile/fingerprint";
import type { DriverTrend } from "../../../server/driver-profile/trend";
import type { LapMeta, SessionMeta, SessionRecap } from "../../../shared/sessions/types";
import hakoneClubCenterlineCsv from "../../../shared/tracks/fm-2023/hakone-s-1641-centerline.csv?raw";
import { HomePageContainer } from "../components/HomePageContainer";
import type { DriverProfileRun } from "../hooks/queries";
import { DEFAULT_DISPLAY_SETTINGS } from "../stores/telemetry";
import { GameStoryScope } from "./GameStoryScope";

const GAME_ID = "fm-2023" as const;
const SESSION_ID = 9001;
const TRACK_ORDINAL = 1641;
const HAKONE_CLUB_OUTLINE = hakoneClubCenterlineCsv
  .trim()
  .split("\n")
  .slice(1)
  .map((line) => {
    const [x, z] = line.split(",").map(Number);
    return { x, z };
  });
const HAKONE_CLUB_TRACK_LENGTH = HAKONE_CLUB_OUTLINE.slice(1).reduce((length, point, index) => {
  const previous = HAKONE_CLUB_OUTLINE[index];
  return length + Math.hypot(point.x - previous.x, point.z - previous.z);
}, 0);

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
    trackOrdinal: TRACK_ORDINAL,
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
    trackOrdinal: TRACK_ORDINAL,
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
  trackOrdinal: TRACK_ORDINAL,
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
  sectorStarts: [0, 1 / 3, 2 / 3],
  improvementSec: 2.898,
  consistency: { stdDevSec: 0.642, rating: 4 },
  personalBest: { isNew: true, previousBestSec: 96.201 },
  sectors: [
    { index: 1, bestLapSec: 31.9, sessionBestSec: 31.781, allTimeBestSec: 31.84, status: "record" },
    { index: 2, bestLapSec: 32.044, sessionBestSec: 32.044, allTimeBestSec: 31.98, status: "session-best" },
    { index: 3, bestLapSec: 31.9, sessionBestSec: 31.812, allTimeBestSec: 31.75, status: "lost" },
  ],
};

const DRIVER_TREND: DriverTrend = {
  recent: {
    laps: laps.map((item) => ({ id: item.id, createdAt: item.createdAt, isValid: item.isValid, relativePacePct: item.isValid ? (item.lapTime / 95.844 - 1) * 100 : null })),
    total: 12,
    valid: 11,
    dirty: 1,
    cleanRate: 11 / 12,
    normalized: 11,
    consistency: 86,
    medianPacePct: 1.1,
    spreadPct: 2.4,
    contexts: 1,
  },
  previous: { laps: [], total: 0, valid: 0, dirty: 0, cleanRate: null, normalized: 0, consistency: null, medianPacePct: null, spreadPct: null, contexts: 0 },
  consistencyDelta: null,
  paceDeltaPct: null,
  spreadDeltaPct: null,
  cleanRateDelta: null,
  consistencyDirection: "unavailable",
  paceDirection: "unavailable",
  validityDirection: "unavailable",
  advice: [{ id: "build-baseline", tone: "neutral", title: "Build a comparable baseline", detail: "Keep recording comparable laps to make this trend reliable." }],
};
const DRIVER_FINGERPRINT: DriverFingerprint = {
  ok: true,
  scope: { kind: "car-track", gameId: GAME_ID, carOrdinal: 201, trackOrdinal: TRACK_ORDINAL },
  laps: { lapIds: laps.map((lap) => lap.id), analyzed: 12, candidates: 12, droppedNoTelemetry: 0 },
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
  trend: DRIVER_TREND,
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
  queryClient.setQueryData(["driver-profile", GAME_ID], { fingerprint: DRIVER_FINGERPRINT, gameName: "Forza Motorsport 2023" });
  queryClient.setQueryData(["driver-profile-runs", GAME_ID], {
    scope: { gameId: GAME_ID },
    gameName: "Forza Motorsport 2023",
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
  ] as const)
    queryClient.setQueryData(["stats", gameId], { totalLaps, totalTimeSec });
  return queryClient;
}

const originalFetch = window.fetch.bind(window);
const carNames: Record<string, string> = { "201": "2023 Cadillac V-Series.R" };
const trackNames: Record<string, string> = { [TRACK_ORDINAL]: "Hakone Club" };

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockHomeFetch(input: RequestInfo | URL, init: RequestInit | undefined, fallbackFetch: typeof window.fetch = originalFetch): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const parsedUrl = new URL(url, window.location.origin);
  const carMatch = parsedUrl.pathname.match(/\/api\/car-name\/(\d+)/);
  if (carMatch) return Promise.resolve(new Response(carNames[carMatch[1]] ?? "Unknown car", { status: 200 }));
  const trackMatch = parsedUrl.pathname.match(/\/api\/track-name\/(\d+)/);
  if (trackMatch) return Promise.resolve(new Response(trackNames[trackMatch[1]] ?? "Unknown track", { status: 200 }));
  if (parsedUrl.searchParams.get("gameId") === GAME_ID) {
    if (parsedUrl.pathname === `/api/track-outline/${TRACK_ORDINAL}`) {
      return jsonResponse({ points: HAKONE_CLUB_OUTLINE, source: "storybook", startYaw: null, flipX: false });
    }
    if (parsedUrl.pathname === `/api/track-sector-boundaries/${TRACK_ORDINAL}` || parsedUrl.pathname === "/api/track-sector-boundaries/42") {
      return jsonResponse({ s1End: 1 / 3, s2End: 2 / 3, trackLength: HAKONE_CLUB_TRACK_LENGTH });
    }
  }
  return fallbackFetch(input, init);
}

/** Installs deterministic API fixtures used by HomePageContainer. */
function MockHomeApi({ children }: { children: ReactNode }) {
  useEffect(() => {
    const previousFetch = window.fetch;
    window.fetch = (input, init) => mockHomeFetch(input, init, previousFetch);
    return () => {
      window.fetch = previousFetch;
    };
  }, []);
  return children;
}

function StoryProviders({ Story }: { Story: ComponentType }) {
  const [queryClient] = useState(createQueryClient);
  const [router] = useState(() => {
    const rootRoute = createRootRoute({ component: Story });
    return createRouter({ routeTree: rootRoute, history: createMemoryHistory({ initialEntries: ["/fm23"] }) });
  });
  return (
    <GameStoryScope gameId={GAME_ID}>
      <MockHomeApi>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </MockHomeApi>
    </GameStoryScope>
  );
}

function withProviders(Story: ComponentType) {
  return <StoryProviders Story={Story} />;
}

const meta = {
  title: "Dashboards/Home Dashboard",
  component: HomePageContainer,
  decorators: [(Story) => withProviders(Story)],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof HomePageContainer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The actual per-game home surface with deterministic profile, activity, stats, laps, and session fixtures. */
export const PerGame: Story = {};
