import type { GameAdapter } from "../types";

const carNames = new Map<number, string>();
const trackNames = new Map<number, string>();

/**
 * iRacing publishes car and track identity in its session-info block instead
 * of a client-side bundled catalogue. This setter is for accepted live-source
 * metadata; parsers and replay/import paths must remain side-effect free.
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
  telemetry: {
    fuel: { packetUnit: "litre" },
    tireTemperature: { packetUnit: "celsius" },
    tirePressure: { packetUnit: "psi" },
    clutch: { source: "direct", freshness: "continuous" },
    pitStatus: { source: "direct", freshness: "continuous" },
    // The live SDK has no per-wheel rotation, slip-angle, or tire-force
    // channels. Its four tire odometers are quantized in 100 m steps, so their
    // derivatives cannot supply live wheel speed or slip either.
    analysis: {
      balance: {
        source: "unavailable",
        reason: "missing-model",
      },
      gripDemand: {
        source: "unavailable",
        reason: "source-limitation",
      },
      traction: {
        source: "unavailable",
        reason: "source-limitation",
      },
      tireTemperature: {
        source: "direct",
        freshness: "pit-snapshot",
        display: "per-wheel",
      },
      surface: {
        source: "direct",
        freshness: "continuous",
        display: "vehicle",
      },
      slipRatio: {
        source: "unavailable",
        reason: "source-limitation",
      },
      slipAngle: {
        source: "unavailable",
        reason: "source-limitation",
      },
      wheelRotation: {
        source: "unavailable",
        reason: "source-limitation",
      },
      tireHealth: {
        source: "direct",
        freshness: "pit-snapshot",
        display: "per-wheel",
      },
      tireWearRate: {
        source: "unavailable",
        reason: "source-limitation",
      },
      tirePressure: {
        source: "direct",
        freshness: "static",
        display: "cold-pressure",
      },
      suspensionTravel: {
        source: "direct",
        freshness: "continuous",
        display: "millimeters",
      },
      suspensionCompressionBias: {
        source: "derived",
        confidence: "exact",
        display: "compression-bias",
      },
    },
  },
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
