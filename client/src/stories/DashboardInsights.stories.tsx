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

const laps: LapMeta[] = [
  lap(1, 5, 100, 102.432), lap(2, 5, 100, 101.907),
  lap(3, 3, 101, 101.225), lap(4, 3, 101, 102.1, gameId, false),
  lap(5, 1, 102, 100.882), lap(6, 1, 102, 101.4),
  lap(7, 2, 103, 104.12, otherGameId),
];
function session(id: number, game: GameId, position: number): SessionMeta {
  return {
    id,
    carOrdinal: 201,
    trackOrdinal: 1641,
    carId: 201,
    trackId: 1641,
    createdAt: "2026-09-29T12:00:00Z",
    sessionType: "Race",
    resultClassification: "finished",
    resultOutcomeStatus: "confirmed",
    finishingPosition: position,
    gameId: game,
  };
}
const sessions = [session(1, gameId, 1), session(2, gameId, 2), session(3, gameId, 3), session(4, gameId, 7), session(5, otherGameId, 1)];
const meta = {
  title: "Dashboards/Dashboard Insights",
  component: DashboardInsights,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="@container/workspace mx-auto max-w-[1000px]"><Story /></div>],
} satisfies Meta<typeof DashboardInsights>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { args: { laps, sessions, gameId: null } };
export const Empty: Story = { args: { laps: [], sessions: [], gameId: null } };
export const Unavailable: Story = { args: { laps, sessions: [], gameId: null } };
export const KnownZero: Story = { args: { laps, sessions: [session(6, gameId, 8)], gameId } };
export const GameFiltered: Story = { args: { laps, sessions, gameId } };
export const Loading: Story = { args: { laps, sessions: [], gameId: null, sessionsLoading: true } };
export const Error: Story = { args: { laps, sessions: [], gameId: null, sessionsError: true } };
