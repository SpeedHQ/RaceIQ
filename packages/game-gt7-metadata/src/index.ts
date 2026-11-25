import type { GameAdapter } from "@raceiq/shared/games/types";
import { gt7TrackName } from "./tracks";
import carsJson from "./cars.json";

const unavailable = { source: "unavailable", reason: "source-limitation" } as const;
const carNameById = new Map(carsJson.cars.map((car) => [car.id, car.name]));

export const gt7Adapter: GameAdapter = {
  id: "gt7",
  displayName: "Gran Turismo 7",
  shortName: "GT7",
  routePrefix: "gt7",
  coordSystem: "gt7-world",
  nativeSectors: false,
  appendsDelayedFinishFrame: false,
  authoritativeTrackLength: false,
  steeringCenter: 0,
  steeringRange: 127,
  followViewRotation: yaw => Math.PI - yaw,
  telemetry: {
    fuel: { packetUnit: "litre", binding: { kind: "value", semanticId: "fuel.fuel" } },
    tireTemperature: { packetUnit: "celsius", binding: { kind: "value", semanticId: "tire.temperature.surface.representative" } },
    handBrake: { source: "direct", freshness: "continuous", binding: { kind: "value", semanticId: "brakes.hand-brake" } },
    analysis: {
      balance: unavailable,
      gripDemand: unavailable,
      traction: unavailable,
      surface: unavailable,
      slipAngle: unavailable,
      lateralSlip: unavailable,
      tirePressure: unavailable,
      tireWearRate: unavailable,
      suspensionCompressionBias: unavailable,
      gForce: unavailable,
      slipRatio: unavailable,
      wheelRotation: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tires.wheel-rotation-speed" } },
      tireTemperature: { source: "direct", freshness: "continuous", display: "per-wheel", binding: { kind: "value", semanticId: "tire.temperature.surface.representative" } },
      tireHealth: unavailable,
      suspensionTravel: { source: "direct", freshness: "continuous", display: "millimeters", binding: { kind: "value", semanticId: "suspension.suspension-travel-m" } },
    },
  },
  tireHealthThresholds: { green: 0.85, yellow: 0.7 },
  tireTempThresholds: { cold: 60, warm: 95, hot: 120 },
  suspensionThresholds: { values: [25, 65, 85], millimeterMode: "absolute" },
  getCarName: id => carNameById.get(id) ?? `GT7 car #${id}`,
  getTrackName: id => gt7TrackName(id) ?? `GT7 track #${id}`,
  carForwardOffset: yaw => [Math.sin(yaw), Math.cos(yaw)],
};
