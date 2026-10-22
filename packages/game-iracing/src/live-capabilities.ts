/** Capabilities of RaceIQ's current live iRacing SDK adapter, independent of sample presence. */
export const iracingLiveCapabilities = {
  // Lap distance is available; stable world-space car position is not.
  worldPosition: false,
} as const;
