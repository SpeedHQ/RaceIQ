import type { GameAdapter } from "../types";

const carNames = new Map<number, string>();
const trackNames = new Map<number, string>();

/**
 * iRacing publishes car and track identity in its session-info block instead
 * of a bundled catalogue. This setter is for accepted live-source metadata;
 * parsers and replay/import paths must remain side-effect free.
 */
export function rememberIRacingIdentity(identity: {
  carId: number;
  carName: string;
  trackId: number;
  trackName: string;
}): void {
  if (identity.carId >= 0 && identity.carName) {
    carNames.set(identity.carId, identity.carName);
  }
  if (identity.trackId >= 0 && identity.trackName) {
    trackNames.set(identity.trackId, identity.trackName);
  }
}

export function injectDiscoveredIRacingIdentity(
  cars: Iterable<{ ordinal: number; name: string }>,
  tracks: Iterable<{ ordinal: number; name: string }>,
): void {
  for (const car of cars) {
    carNames.set(car.ordinal, car.name);
  }
  for (const track of tracks) {
    trackNames.set(track.ordinal, track.name);
  }
}

export const iracingAdapter: GameAdapter = {
  id: "iracing",
  displayName: "iRacing",
  shortName: "iRacing",
  routePrefix: "iracing",
  // iRacing's public telemetry exposes lap distance directly. It does not
  // provide a stable world-space racing-line position in the live SDK row.
  coordSystem: "lap-distance",
  nativeSectors: true,
  getNativeSectorLayout(packet) {
    const starts = packet.iracing?.sectorStarts;
    if (!starts?.length) return undefined;
    return {
      starts,
      lapFraction: packet.iracing?.lapDistancePct,
      trackLengthM: packet.iracing?.trackLengthM,
    };
  },
  appendsDelayedFinishFrame: false,
  authoritativeTrackLength: true,
  steeringCenter: 0,
  steeringRange: 127,
  tireHealthThresholds: { green: 0.85, yellow: 0.70 },
  tireTempThresholds: { cold: 70, warm: 100, hot: 120 },
  suspensionThresholds: { values: [25, 65, 85] },
  tirePressureOptimal: { min: 24, max: 32 },

  getCarName(ordinal: number): string {
    return carNames.get(ordinal) ?? `iRacing car #${ordinal}`;
  },

  getTrackName(ordinal: number): string {
    return trackNames.get(ordinal) ?? `iRacing track #${ordinal}`;
  },

  carForwardOffset(yaw) {
    return [Math.sin(yaw), Math.cos(yaw)];
  },

  followViewRotation(yaw) {
    return Math.PI - yaw;
  },
};
