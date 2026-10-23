export const queryKeys = {
  raceIqOnlineState: (accountEpoch: string | null) => ["raceiq-online", "state", accountEpoch] as const,
  raceIqOnlineLeaderboard: (gameId: string, trackId: string, carId: string, accountEpoch: string | null) =>
    ["raceiq-online", "leaderboard", gameId, trackId, carId, accountEpoch] as const,
};
