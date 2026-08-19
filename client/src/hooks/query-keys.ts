import type { GameId } from "../../../shared/games/ids";

export const queryKeys = {
  laps: ["laps"] as const,
  lapSemanticTelemetry: ["lap-semantic-telemetry"] as const,
  stintTraces: ["stint-traces"] as const,
  lapIssues: ["lap-issues"] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  sessions: ["sessions"] as const,
  sessionEventTimelines: ["session-events"] as const,
  sessionEvents: (sessionId: number | null) => ["session-events", sessionId] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  userTunes: ["user-tunes"] as const,
  catalogTunes: ["catalog-tunes"] as const,
  driverProfile: (gameId: GameId | null) => ["driver-profile", gameId] as const,
  driverProfileRuns: (gameId: GameId | null) => ["driver-profile-runs", gameId] as const,
  sessionResults: ["session-result"] as const,
  sessionResult: (sessionId: number | null, gameId: GameId | null) => ["session-result", sessionId, gameId] as const,
  raceResultSummaries: ["race-result-summary"] as const,
  raceResultSummary: (gameId: GameId | null, trackOrdinal?: number) => ["race-result-summary", gameId, trackOrdinal] as const,
  raceResultRecents: ["race-result-recent"] as const,
  raceResultRecent: (gameId: GameId | null) => ["race-result-recent", gameId] as const,
};

export function qualityUpdatedQueryKeys(sessionId: number) {
  return [
    queryKeys.laps,
    queryKeys.sessions,
    queryKeys.lapSemanticTelemetry,
    queryKeys.stintTraces,
    queryKeys.lapIssues,
    queryKeys.sessionResults,
    queryKeys.raceResultSummaries,
    queryKeys.raceResultRecents,
    ["track-laps"] as const,
    ["session-recap", sessionId] as const,
    ["session-quality", sessionId] as const,
    ["experiment-tests"] as const,
    ["experiment-arm-comparison"] as const,
    ["experiment-line-spread"] as const,
    ["experiment-importable-laps"] as const,
    ["experiment-lap-metrics"] as const,
  ] as const;
}
