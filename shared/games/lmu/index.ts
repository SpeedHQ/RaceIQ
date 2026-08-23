import type { GameAdapter } from "../types";

const carNames = new Map<number, string>();
const trackNames = new Map<number, string>();
const trackOrdinals = new Map<string, number>();

/** Stable positive s32 identity for LMU string-native car and track IDs. */
export function lmuIdentityOrdinal(kind: "car" | "track", name: string): number {
  const normalized = `${kind}:${name.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) & 0x7fffffff || 1;
}

export interface LMUIdentityRecord {
  carId: number;
  carName: string;
  trackId: number;
  trackName: string;
}

export function rememberLMUIdentity(identity: LMUIdentityRecord): void {
  if (identity.carId > 0 && identity.carName) {
    carNames.set(identity.carId, identity.carName);
  }
  if (identity.trackId > 0 && identity.trackName) {
    trackNames.set(identity.trackId, identity.trackName);
    trackOrdinals.set(identity.trackName.trim().toLowerCase(), identity.trackId);
  }
}

export function injectDiscoveredLMUIdentity(
  cars: Iterable<{ ordinal: number; name: string }>,
  tracks: Iterable<{ ordinal: number; name: string }>,
): void {
  for (const car of cars) {
    carNames.set(car.ordinal, car.name);
  }
  for (const track of tracks) {
    trackNames.set(track.ordinal, track.name);
    trackOrdinals.set(track.name.trim().toLowerCase(), track.ordinal);
  }
}

export const lmuAdapter: GameAdapter = {
  id: "lmu",
  displayName: "Le Mans Ultimate",
  shortName: "LMU",
  routePrefix: "lmu",
  telemetry: {
    fuel: {
      packetUnit: "litre",
      binding: { kind: "value", semanticId: "fuel.fuel" },
    },
    tireTemperature: {
      packetUnit: "celsius",
      binding: { kind: "value", semanticId: "tire.temperature.average" },
    },
    power: {
      packetUnit: "watt",
      binding: { kind: "value", semanticId: "engine.power" },
    },
    torque: {
      packetUnit: "newton-metre",
      binding: { kind: "value", semanticId: "engine.torque" },
    },
    brakeTemperature: {
      packetUnit: "celsius",
      binding: { kind: "value", semanticId: "brakes.brake-temp" },
    },
    tirePressure: {
      packetUnit: "psi",
      binding: { kind: "value", semanticId: "tires.tire-pressure" },
    },
    clutch: {
      source: "direct",
      freshness: "continuous",
      binding: { kind: "value", semanticId: "inputs.clutch" },
    },
    weather: {
      source: "direct",
      freshness: "continuous",
      binding: { kind: "value", semanticId: "weather.rain-percent" },
    },
    pitStatus: {
      source: "direct",
      freshness: "continuous",
      binding: { kind: "value", semanticId: "race.on-pit-road" },
    },
    analysis: {
      balance: {
        source: "derived",
        confidence: "high",
        binding: {
          kind: "derived",
          derivation: "physical-balance-v1",
          requires: [
            "motion.speed",
            "motion.acceleration-x",
            "motion.angular-velocity-y",
          ],
        },
      },
      gForce: {
        source: "derived",
        confidence: "exact",
        binding: {
          kind: "derived",
          derivation: "g-force-v1",
          requires: ["motion.acceleration-x", "motion.acceleration-z"],
        },
      },
      gripDemand: {
        source: "derived",
        confidence: "high",
        display: "per-wheel",
        binding: {
          kind: "derived",
          derivation: "friction-circle-v1",
          requires: [
            "motion.speed",
            "tires.wheel-rotation-speed",
            "tires.tire-slip-angle",
          ],
        },
      },
      traction: {
        source: "derived",
        confidence: "exact",
        display: "per-wheel",
        binding: {
          kind: "derived",
          derivation: "traction-v1",
          requires: [
            "motion.speed",
            "inputs.steer",
            "tires.wheel-rotation-speed",
          ],
        },
      },
      tireTemperature: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tire.temperature.average" },
      },
      surface: { source: "unavailable", reason: "source-limitation" },
      slipRatio: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tires.tire-slip-ratio" },
      },
      slipAngle: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tires.tire-slip-angle" },
      },
      lateralSlip: { source: "unavailable", reason: "source-limitation" },
      wheelRotation: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" },
      },
      tireHealth: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tires.tire-wear" },
      },
      tireWearRate: {
        source: "derived",
        confidence: "high",
        display: "per-wheel",
        binding: {
          kind: "derived",
          derivation: "wear-rate-v1",
          requires: ["tires.tire-wear"],
        },
      },
      tirePressure: {
        source: "direct",
        freshness: "continuous",
        display: "per-wheel",
        binding: { kind: "value", semanticId: "tires.tire-pressure" },
      },
      suspensionTravel: {
        source: "direct",
        freshness: "continuous",
        display: "millimeters",
        binding: { kind: "value", semanticId: "suspension.suspension-travel-m" },
      },
      suspensionCompressionBias: {
        source: "unavailable",
        reason: "source-limitation",
      },
    },
  },
  coordSystem: "lmu-world",
  nativeSectors: false,
  appendsDelayedFinishFrame: false,
  authoritativeTrackLength: true,
  steeringCenter: 0,
  steeringRange: 127,
  tireHealthThresholds: { green: 0.85, yellow: 0.7 },
  tireTempThresholds: { cold: 70, warm: 105, hot: 125 },
  suspensionThresholds: { values: [25, 65, 85] },
  tirePressureOptimal: { min: 24, max: 32 },
  brakeTempThresholds: {
    front: { warm: 350, hot: 850 },
    rear: { warm: 300, hot: 800 },
  },

  getCarName(ordinal: number): string {
    return carNames.get(ordinal) ?? `LMU car #${ordinal}`;
  },

  getTrackName(ordinal: number): string {
    return trackNames.get(ordinal) ?? `LMU track #${ordinal}`;
  },

  getTrackOrdinalByName(name: string): number | undefined {
    return trackOrdinals.get(name.trim().toLowerCase());
  },

  carForwardOffset(yaw) {
    return [Math.sin(yaw), Math.cos(yaw)];
  },

  followViewRotation(yaw) {
    return Math.PI - yaw;
  },
};
