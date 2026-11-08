import * as THREE from "three";
import { resolveWheelStates } from "@raceiq/analysis-core/racing/analysis/metric-values";
import { getGame } from "@raceiq/shared/games/registry";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { steeringAngleRadians, visualWheelRotationSpeed } from "../wireframe-utils";
import { semanticNumber, type SemanticAnalysisFrame } from "../semantic-frame";
import { tireTemperatureReadings } from "../tire-temperature-profile";
import type { SceneRuntimeConfig } from "./SceneRuntime";
import { createWheelResource, setWheelSpin, updateWheelResource, type WheelResource } from "./Wheel";
export type AnalysisWheelConfig = Pick<SceneRuntimeConfig, "carModel" | "gameId" | "temperatureSemanticId" | "temperatureThresholds">;

export function createAnalysisWheels(parent: THREE.Object3D, model: AnalysisWheelConfig["carModel"]): WheelResource[] {
  return Array.from({ length: 4 }, (_, index) => {
    const radius = index < 2 ? model.frontTireRadius ?? model.tireRadius : model.rearTireRadius ?? model.tireRadius;
    const width = index < 2 ? model.frontTireWidth ?? 0.3 : model.rearTireWidth ?? 0.3;
    const wheel = createWheelResource(radius, width);
    parent.add(wheel.root);
    return wheel;
  });
}

/** The Analyse wheel pipeline, shared by single-lap analysis and paired replay. */
export function updateAnalysisWheels(
  wheels: readonly WheelResource[], frame: SemanticAnalysisFrame, config: AnalysisWheelConfig,
  elapsed: number, playbackSpeed: number, playing: boolean, rimColor = "var(--app-accent)",
) {
  const model = config.carModel;
  const adapter = getGame(config.gameId);
  const analysis = resolveAnalysisTelemetry(adapter);
  const states = resolveWheelStates(frame, analysis.traction);
  const measured = frame.values["tires.wheel-rotation-speed"];
  const speed = semanticNumber(frame, "motion.speed") ?? 0;
  const steering = steeringAngleRadians(semanticNumber(frame, "inputs.steer") ?? adapter.steeringCenter, adapter);
  const wheelValue = (id: string, index: number): number => {
    const values = frame.values[id];
    return Array.isArray(values) && typeof values[index] === "number" && Number.isFinite(values[index]) ? values[index] : 0;
  };
  return wheels.map((wheel, index) => {
    const isRear = index >= 2, side = index % 2 === 0 ? "left" : "right";
    const radius = (isRear ? model.rearTireRadius : model.frontTireRadius) ?? model.tireRadius;
    const width = (isRear ? model.rearTireWidth : model.frontTireWidth) ?? 0.3;
    const x = isRear ? -model.halfWheelbase : model.halfWheelbase;
    const z = (side === "left" ? -1 : 1) * (isRear ? model.halfRearTrack : model.halfFrontTrack);
    const readings = tireTemperatureReadings(frame, index, side, config.temperatureSemanticId, config.temperatureSemanticId === "tire.temperature.core" ? "core" : config.temperatureSemanticId.includes("carcass") ? "carcass" : "surface");
    updateWheelResource(wheel, { position: [x, 0, z], steerAngle: isRear ? 0 : steering, rimColor, temperatureReadings: readings, temperatureThresholds: config.temperatureThresholds, brakeTemp: wheelValue("brakes.brake-temp", index), side, isRear, onCurb: false, puddleDepth: wheelValue("tires.wheel-in-puddle-depth", index), tireRadius: radius, tireWidth: width });
    const lockup = states[index]?.state === "lockup";
    const rotationSpeed = lockup ? 0 : visualWheelRotationSpeed(Array.isArray(measured) ? measured[index] : undefined, speed, radius, analysis.wheelRotation.source !== "unavailable");
    setWheelSpin(wheel, rotationSpeed, elapsed, playbackSpeed, playing);
    return readings;
  });
}
