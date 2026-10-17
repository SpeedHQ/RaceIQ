import type { GameAdapter } from "@raceiq/shared/games/types";
import { ams2TrackNames } from "./track-names";
const cars = new Map<string, string>();
const tracks = new Map<string, string>();
const trackLengths = new Map<string, number>();
export function getAMS2TrackLength(ordinal: number | string): number | undefined { return trackLengths.get(String(ordinal)); }
export function getAMS2DiscoveredTrackName(ordinal: number | string): string | undefined { return tracks.get(String(ordinal)); }
export function getAMS2DisplayTrackName(id: string): string { const name = tracks.get(id); return name ? ams2TrackNames(name)?.displayName ?? name : `AMS2 track #${id}`; }
export function getAMS2SharedTrackName(id: string): string | undefined { const name = tracks.get(id); return name ? ams2TrackNames(name)?.commonTrackName : undefined; }
export function registerAMS2Identity(car: number | string, carName: string, track: number | string, trackName: string, trackLengthM?: number): void {
  cars.set(String(car), carName); tracks.set(String(track), trackName);
  if (trackLengthM != null && Number.isFinite(trackLengthM) && trackLengthM > 0) trackLengths.set(String(track), trackLengthM);
}
export function injectDiscoveredAMS2Identity(carRows: Iterable<{ ordinal?: number | string; carId?: string; trackId?: string; name: string }>, trackRows: Iterable<{ ordinal?: number | string; carId?: string; trackId?: string; name: string }>): void {
  for (const car of carRows) cars.set(String(car.carId ?? car.ordinal), car.name);
  for (const track of trackRows) tracks.set(String(track.trackId ?? track.ordinal), track.name);
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
  getTrackName: getAMS2DisplayTrackName,
  getSharedTrackName: getAMS2SharedTrackName,
  getTrackIdByName: name => [...tracks].find(([id,n]) => n.toLowerCase() === name.toLowerCase() || getAMS2DisplayTrackName(id).toLowerCase() === name.toLowerCase())?.[0],
};
