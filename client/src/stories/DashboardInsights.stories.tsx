import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { Meta, StoryObj } from "@storybook/react";
import { DashboardInsights } from "../components/home/DashboardInsights";

const gameId = "fm-2023" as GameId;
const otherGameId = "f1-2025" as GameId;
function lap(id: number, dayOffset: number, sessionId: number, lapTime: number, game: GameId = gameId, isValid = true): LapMeta {
  const date = new Date();
  date.setDate(date.getDate() - dayOffset);
  date.setHours(16, id % 60, 0, 0);
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
const names = {
  carNames: { [`${gameId}:201`]: "2023 Cadillac V-Series.R" },
  trackNames: { [`${gameId}:1641`]: "Hakone Club" },
};

const meta = {
  title: "Dashboards/Dashboard Insights",
  component: DashboardInsights,
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="@container/workspace mx-auto max-w-[1000px]"><Story /></div>],
} satisfies Meta<typeof DashboardInsights>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Populated: Story = { args: { laps, gameId: null, ...names } };
export const Empty: Story = { args: { laps: [], gameId: null, carNames: {}, trackNames: {} } };
export const GameFiltered: Story = { args: { laps, gameId, ...names } };
