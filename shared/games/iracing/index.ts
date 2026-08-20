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
    fuel: { packetUnit: "litre", binding: { kind: "value", semanticId: "fuel.remaining-volume" } },
    tireTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "tire.temperature.average" } },
    tirePressure: { packetUnit: "psi", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
    clutch: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "inputs.clutch" } },
    pitStatus: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "race.on-pit-road" } },
    analysis: {
      balance: { source: "derived", confidence: "high", binding: { kind: "derived", derivation: "physical-balance-v1", requires: ["motion.speed", "motion.acceleration-x", "motion.angular-velocity-y"] } },
      gForce: { source: "derived", confidence: "exact", binding: { kind: "derived", derivation: "g-force-v1", requires: ["motion.acceleration-x", "motion.acceleration-z"] } },
      gripDemand: { source: "unavailable", reason: "source-limitation" },
      tireTemperature: { source: "direct", freshness: "pit-snapshot", display: "per-wheel", binding: { kind: "value", semanticId: "tire.temperature.average" } },
      surface: { source: "direct", freshness: "continuous", display: "vehicle", binding: { kind: "value", semanticId: "identity.player-track-surface" } },
      slipRatio: { source: "unavailable", reason: "source-limitation" },
      slipAngle: { source: "unavailable", reason: "source-limitation" },
      lateralSlip: { source: "unavailable", reason: "source-limitation" },
      wheelRotation: { source: "unavailable", reason: "source-limitation" },
      tireHealth: { source: "direct", freshness: "pit-snapshot", display: "per-wheel", binding: { kind: "value", semanticId: "tires.tire-wear" } },
      tireWearRate: { source: "unavailable", reason: "source-limitation" },
      tirePressure: { source: "direct", freshness: "static", display: "cold-pressure", binding: { kind: "value", semanticId: "tires.tire-pressure" } },
      suspensionTravel: { source: "direct", freshness: "continuous", display: "millimeters", binding: { kind: "value", semanticId: "suspension.suspension-travel-m" } },
      suspensionCompressionBias: { source: "unavailable", reason: "source-limitation" },
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
