import type { GameId } from "../../../shared/games/ids";

export const queryKeys = {
  laps: ["laps"] as const,
  lapSemanticTelemetry: ["lap-semantic-telemetry"] as const,
  stintTraces: ["stint-traces"] as const,
  lapIssues: ["lap-issues"] as const,
  lapIssuesForLap: (lapId: number | null, gameId: GameId | null) => ["lap-issues", lapId, gameId] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  sessions: ["sessions"] as const,
  sessionEventTimelines: ["session-events"] as const,
  sessionEventsForSession: (sessionId: number) => ["session-events", sessionId] as const,
  sessionEvents: (sessionId: number | null, gameId: GameId | null) => ["session-events", sessionId, gameId] as const,
  sessionQuality: (sessionId: number | null, gameId: GameId | null) => ["session-quality", sessionId, gameId] as const,
  sessionRunPages: ["session-runs"] as const,
  sessionRuns: (sessionId: number | null, gameId: GameId | null, query: unknown = null) =>
    ["session-runs", sessionId, gameId, query] as const,
  driverStintPages: ["driver-stints"] as const,
  driverStints: (driverId: string | null, query: unknown = null) =>
    ["driver-stints", driverId, query] as const,
  sessionRunDetails: ["session-run-details"] as const,
  sessionRunLaps: (runId: string | null, query: unknown = null) =>
    ["session-run-details", runId, "laps", query] as const,
  sessionRunEvidence: (runId: string | null, query: unknown = null) =>
    ["session-run-details", runId, "evidence", query] as const,
  comparableSessionRuns: (runId: string | null, query: unknown = null) =>
    ["session-run-details", runId, "comparable", query] as const,
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

export function isComparableSessionRunQueryKey(
  queryKey: readonly unknown[],
): boolean {
  return (
    queryKey[0] === "session-run-details" &&
    queryKey[2] === "comparable"
  );
}

export function sessionRunsUpdatedQueryKeys(
  sessionId: number,
  runIds: readonly string[] = [],
) {
  return [
    ["session-runs", sessionId] as const,
    queryKeys.sessions,
    ["driver-stints"] as const,
    ...runIds.map((runId) => ["session-run-details", runId] as const),
  ] as const;
}

export function qualityUpdatedQueryKeys(sessionId: number, gameId?: GameId) {
  return [
    queryKeys.laps,
    queryKeys.sessions,
    queryKeys.sessionRunPages,
    queryKeys.sessionRunDetails,
    queryKeys.driverStintPages,
    queryKeys.lapSemanticTelemetry,
    queryKeys.stintTraces,
    queryKeys.lapIssues,
    queryKeys.sessionResults,
    queryKeys.raceResultSummaries,
    queryKeys.raceResultRecents,
    ["track-laps"] as const,
    ["session-recap", sessionId] as const,
    gameId == null ? (["session-quality", sessionId] as const) : queryKeys.sessionQuality(sessionId, gameId),
    ["experiment-tests"] as const,
    ["experiment-arm-comparison"] as const,
    ["experiment-line-spread"] as const,
    ["experiment-importable-laps"] as const,
    ["experiment-lap-metrics"] as const,
  ] as const;
}
