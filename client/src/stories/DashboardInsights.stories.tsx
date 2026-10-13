import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { type ComponentType, useState } from "react";
import { DEFAULT_DISPLAY_SETTINGS } from "@/stores/telemetry";
function StoryProviders({ Story }: { Story: ComponentType }) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["settings"], DEFAULT_DISPLAY_SETTINGS);
    return client;
  });
  const [router] = useState(() => createRouter({
    routeTree: createRootRoute({ component: Story }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  }));
  return <QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>;
}
import { reduceDashboard, type DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardInsights } from "../components/home/DashboardInsights";

const gameId = "fm-2023" as const;
const otherGameId = "f1-2025" as const;
const request = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };
function lap(id: number, dayOffset: number, sessionId: number, lapTime: number, game = gameId, isValid = true): LapMeta {
  const date = new Date("2026-09-30T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - dayOffset);
  date.setUTCHours(16, id % 60, 0, 0);
  return { id, sessionId, lapNumber: id, lapTime, isValid, createdAt: date.toISOString(), gameId: game, carId: "201", trackId: "1641", ownership: "mine", invalidReason: undefined };
}
function session(id: number, game: typeof gameId | typeof otherGameId, position: number, type = "Race"): SessionMeta {
  return { id, carId: String(200 + id), trackId: String(1600 + id), createdAt: "2026-09-29T12:00:00Z", lapCount: 0, bestLapTime: null, sessionType: type, elapsedSeconds: id === 106 ? null : 1800 + id * 60, resultClassification: "finished", resultOutcomeStatus: "confirmed", finishingPosition: position, gameId: game, ownership: "mine" };
}
const sessions = [session(100, gameId, 1), session(101, gameId, 2), session(102, gameId, 3), session(103, gameId, 4), session(104, gameId, 4), session(105, gameId, 7), session(106, gameId, 12), session(107, gameId, 1, "Practice"), session(108, gameId, 1, "Qualifying"), session(109, otherGameId, 1)];
const mixedLaps: LapMeta[] = [lap(1, 5, 100, 102.432), lap(2, 5, 100, 101.907), lap(3, 4, 103, 99.2), lap(4, 4, 104, 100.1), lap(5, 3, 105, 105.3), lap(6, 3, 107, 110), lap(7, 2, 108, 111), lap(8, 1, 109, 95, otherGameId)];
const reduce = (laps: readonly LapMeta[], sourceSessions: readonly SessionMeta[] = sessions): DashboardResponse => reduceDashboard(laps, sourceSessions, request);
const meta = { title: "Dashboards/Dashboard Insights", component: DashboardInsights, args: { periodStart: Date.parse(request.from), gameId }, parameters: { layout: "padded" }, decorators: [(Story) => <StoryProviders Story={() => <div className="@container/workspace mx-auto max-w-[1000px]"><Story /></div>} />] } satisfies Meta<typeof DashboardInsights>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Populated: Story = { args: { response: reduce(mixedLaps), gameId } };
export const Empty: Story = { args: { response: reduce([], []), gameId: null } };
export const Unavailable: Story = { args: { response: undefined, gameId: null, sessionsError: true } };
export const KnownZero: Story = { args: { response: reduce([], [session(110, gameId, 8)]), gameId } };
export const GameFiltered: Story = { args: { response: reduce(mixedLaps), gameId: otherGameId } };
export const PracticeOnly: Story = { args: { response: reduce([lap(11, 1, 111, 98)], [session(111, gameId, 1, "Practice")]), gameId } };
export const RaceOnly: Story = { args: { response: reduce([lap(12, 1, 112, 99)], [session(112, gameId, 1)]), gameId } };
export const EmptyOtherFinishes: Story = { args: { response: reduce([], [session(113, gameId, 1)]), gameId } };
export const Loading: Story = { args: { response: undefined, gameId: null, sessionsLoading: true } };
export const Error: Story = { args: { response: undefined, gameId: null, sessionsError: true } };
export const PartialTiming: Story = { args: { response: reduce([], [session(120, gameId, 1, "Practice"), session(106, gameId, 1, "Race")]), gameId } };
export const UnknownSessionType: Story = { args: { response: reduce([], [session(121, gameId, 1, "test-day")]), gameId } };
export const CleanLapTrend: Story = { args: { response: reduce(Array.from({ length: 30 }, (_, index) => lap(200 + index, 30 - index, 100, 90, gameId, index >= 12 || index % 3 === 0))), gameId } };
export const CleanLapsLoading: Story = { args: { response: reduce(mixedLaps), gameId, lapsLoading: true } };
export const CleanLapsError: Story = { args: { response: reduce(mixedLaps), gameId, lapsError: true } };
export const PodiumTrend: Story = { args: { response: reduce(mixedLaps, Array.from({ length: 30 }, (_, index) => ({ ...session(300 + index, gameId, index < 12 && index % 3 !== 0 ? 5 : index % 3 + 1), createdAt: new Date(Date.now() - (30 - index) * 86_400_000).toISOString() }))), gameId } };

const nativeTrackId = JSON.stringify(["Nürburgring", "Tourist"]);
const nativeCarId = "car-alpha";
export const NativeVenueLayout: Story = {
  args: {
    gameId: "ac-evo",
    trackNames: { [`ac-evo:${nativeTrackId}`]: "Nürburgring Tourist" },
    carNames: { [`ac-evo:${nativeCarId}`]: "AC Evo Test Car" },
    response: reduceDashboard(
      [{ ...mixedLaps[0]!, gameId: "ac-evo", carId: nativeCarId, trackId: nativeTrackId }],
      [{ ...sessions[0]!, gameId: "ac-evo", carId: nativeCarId, trackId: nativeTrackId }],
      request,
    ),
  },
};
