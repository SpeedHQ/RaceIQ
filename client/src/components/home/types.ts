import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta, SessionRecap as SessionRecapDto } from "@raceiq/shared/racing/sessions/types";
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
    favCarOrd: number | null;
    favCarCount: number;
  }
>;

export type GameStats = Record<"fm" | "f1" | "acc" | "acEvo" | "iracing" | "lmu", { laps: number; time: string }>;

export interface HomePageViewProps {
  gameId: GameId | null;
  gameDisplayName: string | null;
  allLaps: LapMeta[];
  periodStart: number;
  sessions: SessionMeta[];
  recentSessions: SessionMeta[];
  carNames: Record<string, string>;
  trackNames: Record<string, string>;
  gameStats: GameStats;
  hiddenGames: string[];
  latestSession: SessionMeta | null;
  latestRecap: SessionRecapDto | null | undefined;
  latestRecapLoading: boolean;
  latestRecapError: boolean;
  latestRecapOutline?: TrackOutlineData;
  latestRecapBounds?: TrackSectorBounds;
  latestRecapCarImageUrl?: string;
  onAnalyseSession: (session: SessionMeta) => void;
  lapsLoading?: boolean;
  lapsError?: boolean;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
  periodTab: PeriodKey;
  periodStats: PeriodStats;
  onPeriodTabChange: (period: PeriodKey) => void;
}
