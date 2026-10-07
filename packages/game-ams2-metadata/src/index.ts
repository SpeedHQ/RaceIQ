import type { GameAdapter } from "@raceiq/shared/games/types";
const cars = new Map<number, string>();
const tracks = new Map<number, string>();
const trackLengths = new Map<number, number>();
export function getAMS2TrackLength(ordinal: number): number | undefined { return trackLengths.get(ordinal); }
export function registerAMS2Identity(car: number, carName: string, track: number, trackName: string, trackLengthM?: number): void {
  cars.set(car, carName); tracks.set(track, trackName);
  if (trackLengthM != null && Number.isFinite(trackLengthM) && trackLengthM > 0) trackLengths.set(track, trackLengthM);
}
export function injectDiscoveredAMS2Identity(carRows: Iterable<{ ordinal: number; name: string }>, trackRows: Iterable<{ ordinal: number; name: string }>): void {
  for (const car of carRows) cars.set(car.ordinal, car.name);
  for (const track of trackRows) tracks.set(track.ordinal, track.name);
}
const unavailable = { source: "unavailable", reason: "source-limitation" } as const;
export const ams2Adapter: GameAdapter = {
  id: "ams2", displayName: "Automobilista 2", shortName: "AMS2", routePrefix: "ams2",
  coordSystem: "ams2-world", nativeSectors: false, appendsDelayedFinishFrame: false,
  authoritativeTrackLength: true, steeringCenter: 0, steeringRange: 127,
  carForwardOffset: yaw => [Math.sin(yaw), Math.cos(yaw)],
  followViewRotation: yaw => Math.PI - yaw,
  telemetry: {
    fuel: { packetUnit: "litre", binding: {kind: "value", semanticId: "fuel.fuel"} },
    tireTemperature: {packetUnit: "celsius", binding: {kind: "value", semanticId: "tire.temperature.surface.representative"}},
    brakeTemperature: {packetUnit: "celsius", binding: {kind: "value", semanticId: "brakes.brake-temp"}},
    tirePressure: {packetUnit: "psi", binding: {kind: "value", semanticId: "tires.tire-pressure"}},
    clutch: {source: "direct", freshness: "continuous", binding: {kind: "value", semanticId: "inputs.clutch"}},
    pitStatus: {source: "direct", freshness: "continuous", binding: {kind: "value", semanticId: "race.on-pit-road"}},
    analysis: {balance: unavailable, gripDemand: unavailable, traction: unavailable,
      surface: unavailable, slipRatio: unavailable, slipAngle: unavailable, lateralSlip: unavailable,
      suspensionCompressionBias: unavailable,
      suspensionTravel: {source: "direct", freshness: "continuous", display: "millimeters", binding: {kind: "value", semanticId: "suspension.suspension-travel-m"}},
      wheelRotation: {source: "direct", freshness: "continuous", display: "per-wheel", binding: {kind: "value", semanticId: "tires.wheel-rotation-speed"}},
      tireTemperature: {source: "direct", freshness: "continuous", display: "per-wheel", binding: {kind: "value", semanticId: "tire.temperature.surface.representative"}},
      tirePressure: {source: "direct", freshness: "continuous", display: "per-wheel", binding: {kind: "value", semanticId: "tires.tire-pressure"}},
      tireHealth: {source: "direct", freshness: "continuous", display: "per-wheel", binding: {kind: "value", semanticId: "tires.tire-wear"}},
    },
  },
  tireHealthThresholds: {green: .85, yellow: .7}, tireTempThresholds: {cold: 70, warm: 105, hot: 125},
  suspensionThresholds: {values: [25,65,85]},
  getCarName: id => cars.get(id) ?? `AMS2 car #${id}`,
  getTrackName: id => tracks.get(id) ?? `AMS2 track #${id}`,
  getTrackOrdinalByName: name => [...tracks].find(([,n]) => n.toLowerCase() === name.toLowerCase())?.[0],
};
