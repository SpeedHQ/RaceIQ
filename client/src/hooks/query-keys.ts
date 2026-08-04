import type { GameId } from "../../../shared/games/ids";

export const queryKeys = {
  laps: ["laps"] as const,
  settings: ["settings"] as const,
  trackName: (ord: number) => ["track-name", ord] as const,
  trackSectors: (ord: number) => ["track-sectors", ord] as const,
  trackSectorBoundaries: (ord: number) => ["track-sector-boundaries", ord] as const,
  trackOutline: (ord: number) => ["track-outline", ord] as const,
  sessions: ["sessions"] as const,
  tracks: ["tracks"] as const,
  carName: (ord: number) => ["car-name", ord] as const,
  userTunes: ["user-tunes"] as const,
  catalogTunes: ["catalog-tunes"] as const,
  driverProfile: (gameId: GameId | null) => ["driver-profile", gameId] as const,
  driverProfileRuns: (gameId: GameId | null) => ["driver-profile-runs", gameId] as const,
};
