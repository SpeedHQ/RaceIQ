import type { GameId } from "@raceiq/shared/games/ids";
import { getGame } from "@raceiq/shared/games/registry";
import type { LiveTelemetryView } from "@/lib/live-telemetry-view";
import type { SemanticReplayFrame } from "@raceiq/lap-replay/contracts";
import type { SemanticTuneSample, TuneWheelValues } from "@raceiq/analysis-core/racing/laps/semantic-tune";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function wheelValues(value: unknown): TuneWheelValues | undefined {
  if (!Array.isArray(value) || value.length < 4 || !value.slice(0, 4).every((item) => typeof item === "number" && Number.isFinite(item))) return undefined;
  return { fl: value[0], fr: value[1], rl: value[2], rr: value[3] };
}
function sampleFromValues(gameId: GameId, values: Readonly<Record<string, unknown>>): SemanticTuneSample {
  const positionX = finiteNumber(values["motion.position-x"]);
  const positionZ = finiteNumber(values["motion.position-z"]);
  const fuel = finiteNumber(values["fuel.fuel"]);
  const fuelUnit = getGame(gameId).telemetry.fuel.packetUnit;
  return {
    gameId, distanceM: finiteNumber(values["timing.distance-traveled"]), speedMps: finiteNumber(values["motion.speed"]),
    trackId: typeof values["identity.track-id"] === "string" ? values["identity.track-id"] : undefined,
    positionM: positionX === undefined || positionZ === undefined ? undefined : { x: positionX, z: positionZ },
    tireSurfaceTemperatureC: wheelValues(values["tire.temperature.surface.representative"]), tireCoreTemperatureC: wheelValues(values["tire.temperature.core"]),
    tireCarcassMiddleTemperatureC: wheelValues(values["tire.temperature.carcass.middle"]), brakeTemperatureC: wheelValues(values["brakes.brake-temp"]),
    tirePressurePsi: wheelValues(values["tires.tire-pressure"]), tireWearFraction: wheelValues(values["tires.tire-wear"]), fuel, fuelUnit,
  };
}
export function semanticSamples(gameId: GameId, frames: SemanticReplayFrame[] | undefined): SemanticTuneSample[] {
  return (frames ?? []).filter((frame) => frame.simulator === gameId).map((frame) => sampleFromValues(gameId, Object.fromEntries(
    frame.values.filter((entry) => (!entry.state || entry.state === "ok") && (!entry.freshness || entry.freshness === "fresh")).map((entry) => [entry.semanticId, entry.value]),
  )));
}
export function semanticTuneSampleFromView(view: LiveTelemetryView): SemanticTuneSample {
  const fuelUnit = getGame(view.simulator).telemetry.fuel.packetUnit;
  const surface = view.tires.surfaceTemperatureC;
  const surfaceValues = surface ? [surface.fl.representative, surface.fr.representative, surface.rl.representative, surface.rr.representative] : [];
  const tireSurfaceTemperatureC = surfaceValues.length === 4 && surfaceValues.every((value): value is number => typeof value === "number" && Number.isFinite(value)) ? { fl: surfaceValues[0], fr: surfaceValues[1], rl: surfaceValues[2], rr: surfaceValues[3] } : undefined;
  const carcass = view.tires.carcassTemperatureC;
  const carcassValues = carcass ? [carcass.fl.middle, carcass.fr.middle, carcass.rl.middle, carcass.rr.middle] : [];
  const tireCarcassMiddleTemperatureC = carcassValues.length === 4 && carcassValues.every((value): value is number => typeof value === "number" && Number.isFinite(value)) ? { fl: carcassValues[0], fr: carcassValues[1], rl: carcassValues[2], rr: carcassValues[3] } : undefined;
  return {
    gameId: view.simulator, distanceM: view.motion.distanceM, speedMps: view.motion.speedMps, trackId: view.identity.trackId, positionM: view.motion.position,
    tireSurfaceTemperatureC, tireCoreTemperatureC: view.tires.coreTemperatureC, tireCarcassMiddleTemperatureC, brakeTemperatureC: view.tires.brakeTemperatureC,
    tirePressurePsi: view.tires.pressurePsi, tireWearFraction: view.tires.wear, fuel: view.fuel.amount, fuelUnit,
  };
}
