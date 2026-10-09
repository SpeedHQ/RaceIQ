import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardInsights } from "../components/home/DashboardInsights";

const gameId = "fm-2023" as GameId;
const otherGameId = "f1-2025" as GameId;
function lap(id: number, dayOffset: number, sessionId: number, lapTime: number, game: GameId = gameId, isValid = true): LapMeta {
  const date = new Date("2026-09-30T12:00:00Z");
  date.setUTCDate(date.getUTCDate() - dayOffset);
  date.setUTCHours(16, id % 60, 0, 0);
  return {
    id,
    sessionId,
    lapNumber: id,
    lapTime,
    isValid,
    createdAt: date.toISOString(),
    gameId: game,
    carOrdinal: 201,
    trackOrdinal: 1641,
  };
}

function session(id: number, game: GameId, position: number, type = "Race"): SessionMeta {
  return {
    id,
    carOrdinal: 200 + id,
    trackOrdinal: 1600 + id,
    carId: 200 + id,
    trackId: 1600 + id,
    createdAt: "2026-09-29T12:00:00Z",
    sessionType: type,
    elapsedSeconds: id === 106 ? null : 1800 + id * 60,
    resultClassification: "finished",
    resultOutcomeStatus: "confirmed",
    finishingPosition: position,
    gameId: game,
  };
}
const sessions = [
  session(100, gameId, 1), session(101, gameId, 2), session(102, gameId, 3),
  session(103, gameId, 4), session(104, gameId, 4), session(105, gameId, 7),
  session(106, gameId, 12), session(107, gameId, 1, "Practice"),
  session(108, gameId, 1, "Qualifying"), session(109, otherGameId, 1),
];
const mixedLaps: LapMeta[] = [
  lap(1, 5, 100, 102.432), lap(2, 5, 100, 101.907),
  lap(3, 4, 103, 99.2), lap(4, 4, 104, 100.1),
  lap(5, 3, 105, 105.3), lap(6, 3, 107, 110),
  lap(7, 2, 108, 111), lap(8, 1, 109, 95, otherGameId),
];
const meta = {
  title: "Dashboards/Dashboard Insights",
  component: DashboardInsights,
  args: { periodStart: Date.now() - 365 * 86_400_000 },
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="@container/workspace mx-auto max-w-[1000px]"><Story /></div>],
} satisfies Meta<typeof DashboardInsights>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { args: { laps: mixedLaps, sessions, gameId } };
export const Empty: Story = { args: { laps: [], sessions: [], gameId: null } };
export const Unavailable: Story = { args: { laps: mixedLaps, sessions: [], gameId: null } };
export const KnownZero: Story = { args: { laps: mixedLaps, sessions: [session(110, gameId, 8)], gameId } };
export const GameFiltered: Story = { args: { laps: mixedLaps, sessions, gameId } };
export const PracticeOnly: Story = { args: { laps: [lap(11, 1, 111, 98)], sessions: [session(111, gameId, 1, "Practice")], gameId } };
export const RaceOnly: Story = { args: { laps: [lap(12, 1, 112, 99)], sessions: [session(112, gameId, 1)], gameId } };
export const EmptyOtherFinishes: Story = { args: { laps: [], sessions: [session(113, gameId, 1)], gameId } };
export const Loading: Story = { args: { laps: mixedLaps, sessions: [], gameId: null, sessionsLoading: true } };
export const Error: Story = { args: { laps: mixedLaps, sessions: [], gameId: null, sessionsError: true } };
export const PartialTiming: Story = { args: { laps: [], sessions: [session(120, gameId, 1, "Practice"), session(106, gameId, 1, "Race")], gameId } };
export const UnknownSessionType: Story = { args: { laps: [], sessions: [session(121, gameId, 1, "test-day")], gameId } };
export const CleanLapTrend: Story = {
  args: {
    laps: Array.from({ length: 30 }, (_, index) => lap(200 + index, 30 - index, 100, 90, gameId, index >= 12 || index % 3 === 0)),
    sessions,
    gameId,
  },
};
export const CleanLapsLoading: Story = { args: { laps: mixedLaps, sessions, gameId, lapsLoading: true } };
export const CleanLapsError: Story = { args: { laps: mixedLaps, sessions, gameId, lapsError: true } };
export const PodiumTrend: Story = {
  args: {
    laps: mixedLaps,
    sessions: Array.from({ length: 30 }, (_, index) => ({
      ...session(300 + index, gameId, index < 12 && index % 3 !== 0 ? 5 : index % 3 + 1),
      createdAt: new Date(Date.now() - (30 - index) * 86_400_000).toISOString(),
    })),
    gameId,
  },
};
