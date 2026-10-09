import type { GameId } from "@raceiq/shared/games/ids";
import type { DashboardRecentSession, DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";
import type { SessionRecap as SessionRecapDto } from "@raceiq/shared/racing/sessions/types";
import type { TrackOutlineData, TrackSectorBounds } from "@/components/SessionRecap";

export type PeriodKey = "today" | "week" | "month" | "year";

export type PeriodStats = Record<
  PeriodKey,
  {
    laps: number;
    valid: number;
    best: number;
    avgTime: number;
    totalTime: number;
    tracks: number;
    cars: number;
    sessions: number;
  }
>;

export type GameStats = Record<"fm" | "f1" | "acc" | "acEvo" | "iracing" | "lmu", { laps: number; time: string }>;

export interface HomePageViewProps {
  gameId: GameId | null;
  gameDisplayName: string | null;
  response: DashboardResponse | undefined;
  periodStart: number;
  sessions: DashboardRecentSession[];
  carNames: Record<string, string>;
  trackNames: Record<string, string>;
  gameStats: GameStats;
  hiddenGames: string[];
  latestSession: DashboardRecentSession | null;
  latestRecap: SessionRecapDto | null | undefined;
  latestRecapLoading: boolean;
  latestRecapError: boolean;
  latestRecapOutline?: TrackOutlineData;
  latestRecapBounds?: TrackSectorBounds;
  latestRecapCarImageUrl?: string;
  onAnalyseSession: (session: DashboardRecentSession) => void;
  lapsLoading?: boolean;
  lapsError?: boolean;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
  periodTab: PeriodKey;
  periodStats: PeriodStats;
  onPeriodTabChange: (period: PeriodKey) => void;
}
