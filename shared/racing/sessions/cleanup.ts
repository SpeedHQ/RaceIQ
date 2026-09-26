import type { GameId } from "@shared/games/ids";

export type CleanupAgeDays = 7 | 30 | 90 | 180 | 365;

export type SessionCleanupRequest = { mode: "older-than"; olderThanDays: CleanupAgeDays } | { mode: "selected"; sessionIds: number[] };

export interface SessionCleanupLapDetail {
  id: number;
  sessionId: number;
  lapNumber: number;
  lapTime: number;
  isValid: boolean;
}

export interface SessionCleanupSessionDetail {
  id: number;
  createdAt: string;
  trackName: string;
  carName: string;
  laps: SessionCleanupLapDetail[];
}

export interface SessionCleanupGameSummary {
  gameId: GameId;
  gameName: string;
  sessionCount: number;
  reclaimableBytes: number;
  sessions: SessionCleanupSessionDetail[];
}

export interface SessionCleanupPreview {
  candidateSessionIds: number[];
  protectedSessionIds: number[];
  unavailableSessionIds: number[];
  fileCount: number;
  reclaimableBytes: number;
  games: SessionCleanupGameSummary[];
}

export interface SessionCleanupResult extends SessionCleanupPreview {
  cleanedSessionIds: number[];
  deletedFiles: number;
  freedBytes: number;
  failed: { sessionIds: number[]; message: string }[];
}
