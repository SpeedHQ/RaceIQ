import { resolveWheelStates } from "../../../../shared/racing/analysis/metric-values";
import { getGame } from "@shared/games/registry";
import { resolveAnalysisTelemetry } from "@shared/racing/analysis/telemetry-capabilities";
import * as THREE from "three/webgpu";
import type { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { normalizeSuspensionTravel } from "../../lib/suspension";
import { steeringAngleRadians, THREE_COLORS, visualWheelRotationSpeed } from "../../lib/wireframe-utils";
import { semanticNumber, type SemanticAnalysisFrame } from "../analyse/track-map/types";
import { tireTemperatureReadings } from "../analyse/tire-temperature-profile";
import { buildLoadTrail } from "./CarScene";
import { createCurbMarkerResource, disposeCurbMarkerResource, updateCurbMarkerResource, type CurbMarkerResource } from "./CurbMarkers";
import { createDimensionLineResource, disposeDimensionLineResource, updateDimensionLineResource, type DimensionLineResource } from "./DimensionLines";
import { createInputOverlayResource, disposeInputOverlayResource, updateInputOverlayResource, type InputOverlayResource } from "./InputOverlay";
import { createOpaqueWideLine, createRetainedGrid, createRibbonPool, disposeOpaqueWideLine, disposeRibbonPool, updateOpaqueWideLine, updateRibbonPool, type RetainedGrid, type RibbonPool } from "./LineResources";
import type { SceneRuntimeConfig, SceneSource } from "./SceneRuntime";
import { createSuspensionSpringResource, disposeSuspensionSpringResource, updateSuspensionSpringResource, type SuspensionSpringResource } from "./SuspensionSpring";
import { createTireTrailResource, disposeTireTrailResource, updateTireTrailResource, type TireTrailResource } from "./TireTrails";
import { createTrackBoundaryResource, createTrackLineResource, disposeTrackBoundaryResource, disposeTrackLineResource, updateTrackBoundaryResource, updateTrackLineResource, type TrackBoundaryResource, type TrackLineResource } from "./TrackElements";
import { createWheelResource, disposeWheelResource, setWheelSpin, updateWheelResource, type WheelResource } from "./Wheel";
import { createWheelLabelResource, disposeWheelLabelResource, updateWheelLabelResource, updateWheelLabelScale, type WheelLabelResource } from "./WheelLabels";

const wheelValue = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"], index: number): number => {
  const values = frame.values[id];
  return Array.isArray(values) && typeof values[index] === "number" && Number.isFinite(values[index]) ? values[index] : 0;
};

/** Persistent visual resources. One update handles same frame/history/camera snapshot as render. */
export class SceneOverlays {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly grid: RetainedGrid;
  private readonly loadTrail: RibbonPool;
  private readonly loadDot: THREE.Mesh;
  private readonly drivetrain: THREE.Group;
  private readonly axles: Line2[] = [];
  private wheelModel: SceneRuntimeConfig["carModel"] | null = null;
  private wheels: WheelResource[] = [];
  private labels: (WheelLabelResource | null)[] = [null, null, null, null];
  private springs: SuspensionSpringResource[] = [];
  private dimensions: DimensionLineResource | null = null;
  private track: TrackLineResource | null = null;
  private racingLine: TrackLineResource | null = null;
  private boundaries: TrackBoundaryResource | null = null;
  private curbs: CurbMarkerResource | null = null;
  private trail: TireTrailResource | null = null;
  private inputs: InputOverlayResource | null = null;
  private history: SemanticAnalysisFrame[] | null = null;
  private historyGeneration = -1;
  private curbPoints: { x: number; z: number }[] = [];
  private puddlePoints: { x: number; z: number }[] = [];
  private readonly wearRates = [0, 0, 0, 0];
  private readonly previousWear = [0, 0, 0, 0];
  private previousTimestamp = 0;
  private previousSample: SemanticAnalysisFrame | null = null;
  private lastLabelUpdate = -Infinity;
  private lastLabelGeneration = -1;
  private readonly axlePositions = Array.from({ length: 3 }, () => [new THREE.Vector3(), new THREE.Vector3()]);

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.scene = scene;
    this.camera = camera;
    this.grid = createRetainedGrid();
    scene.add(this.grid.group);
    this.loadTrail = createRibbonPool({ opacity: 0.55 });
    scene.add(this.loadTrail.group);
    this.loadDot = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), new THREE.MeshBasicMaterial({ color: THREE_COLORS.loadDistribution }));
    scene.add(this.loadDot);
    this.drivetrain = new THREE.Group();
    for (const [color, width] of [[THREE_COLORS.appTextDim, 2], [THREE_COLORS.appTextDim, 2], [THREE_COLORS.wireframeStructure, 1.5]] as const) {
      const line = createOpaqueWideLine(color, width);
      this.drivetrain.add(line);
      this.axles.push(line);
    }
    for (let i = 0; i < 2; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.12, 0.2), new THREE.MeshBasicMaterial({ color: THREE_COLORS.appTextDim, wireframe: true }));
      this.drivetrain.add(box);
    }
    scene.add(this.drivetrain);
  }

  private replaceWheels(config: SceneRuntimeConfig): void {
    this.labels.forEach((label) => { if (label) disposeWheelLabelResource(label); });
    this.labels = [null, null, null, null];
    for (const wheel of this.wheels) disposeWheelResource(wheel);
    this.wheels = [];
    for (let index = 0; index < 4; index++) {
      const radius = index < 2 ? config.carModel.frontTireRadius ?? config.carModel.tireRadius : config.carModel.rearTireRadius ?? config.carModel.tireRadius;
      const width = index < 2 ? config.carModel.frontTireWidth ?? 0.3 : config.carModel.rearTireWidth ?? 0.3;
      const wheel = createWheelResource(radius, width);
      this.scene.add(wheel.root);
      this.wheels.push(wheel);
    }
    this.wheelModel = config.carModel;
    if (this.trail) { disposeTireTrailResource(this.trail); this.trail = null; }
  }

  private updateHistory(frames: SemanticAnalysisFrame[], generation: number): void {
    if (this.history === frames) {
      if (this.historyGeneration !== generation) {
        this.historyGeneration = generation;
        this.grid.resetPose();
        this.previousSample = null;
      }
      return;
    }
    this.history = frames;
    this.historyGeneration = generation;
    this.grid.resetPose();
    const curbs: { x: number; z: number }[] = [];
    const puddles: { x: number; z: number }[] = [];
    for (const frame of frames) {
      const x = semanticNumber(frame, "motion.position-x"), z = semanticNumber(frame, "motion.position-z");
      if (x == null || z == null) continue;
      const curb = frame.values["tires.wheel-on-rumble-strip"];
      const puddle = frame.values["tires.wheel-in-puddle-depth"];
      if (Array.isArray(curb) && curb.some((value) => typeof value === "number" && value > 0)) curbs.push({ x, z });
      if (Array.isArray(puddle) && puddle.some((value) => typeof value === "number" && value > 0)) puddles.push({ x, z });
    }
    this.curbPoints = curbs;
    this.puddlePoints = puddles;
    if (this.inputs) this.inputs.indexSource = null;
    this.previousSample = null;
  }

  update(frame: SemanticAnalysisFrame, frames: SemanticAnalysisFrame[], cursorIdx: number, config: SceneRuntimeConfig, source: SceneSource | null, now: number, elapsed: number, generation: number, viewportHeight: number): void {
    if (this.wheelModel !== config.carModel) this.replaceWheels(config);
    this.updateHistory(frames, source?.seekGeneration ?? 0);
    const yaw = semanticNumber(frame, "motion.yaw") ?? 0;
    const px = semanticNumber(frame, "motion.position-x") ?? 0, pz = semanticNumber(frame, "motion.position-z") ?? 0;
    this.grid.group.visible = config.toggles.grid;
    if (config.toggles.grid) this.grid.updatePose(px, pz, yaw);
    else this.grid.resetPose();
    const wb = config.carModel.halfWheelbase, ft = config.carModel.halfFrontTrack, rt = config.carModel.halfRearTrack;
    const fRadius = config.carModel.frontTireRadius ?? config.carModel.tireRadius;
    const rRadius = config.carModel.rearTireRadius ?? config.carModel.tireRadius;
    const fWidth = config.carModel.frontTireWidth ?? 0.3, rWidth = config.carModel.rearTireWidth ?? 0.3;
    const suspensionRange = config.gameId === "acc" ? { min: 0, max: 50 } : config.gameId === "iracing" ? { min: 0, max: 100 } : undefined;
    const normalized = frame.values["suspension.norm-suspension-travel"];
    const suspension = Array.isArray(normalized) && normalized.length >= 4 &&
      Number.isFinite(normalized[0]) && Number.isFinite(normalized[1]) &&
      Number.isFinite(normalized[2]) && Number.isFinite(normalized[3])
      ? normalized as number[] : normalizeSuspensionTravel(frame.values["suspension.suspension-travel-m"] as unknown[], suspensionRange);
    const steering = steeringAngleRadians(semanticNumber(frame, "inputs.steer") ?? 0);
    const analysis = resolveAnalysisTelemetry(getGame(config.gameId));
    const states = resolveWheelStates(frame, analysis.traction);
    const measured = frame.values["tires.wheel-rotation-speed"];
    const speed = semanticNumber(frame, "motion.speed") ?? 0;
    const brakeTemps = frame.values["brakes.brake-temp"];
    const labelNow = !source?.playing || source.recording || now - this.lastLabelUpdate >= 100 || generation !== this.lastLabelGeneration;
    if (labelNow) { this.lastLabelUpdate = now; this.lastLabelGeneration = generation; }
    const stroke = config.carModel.suspStroke ?? 0.08;
    for (let index = 0; index < 4; index++) {
      const isRear = index >= 2, side: "left" | "right" = index % 2 === 0 ? "left" : "right";
      const radius = isRear ? rRadius : fRadius, width = isRear ? rWidth : fWidth;
      const x = isRear ? -wb : wb, z = (side === "left" ? -1 : 1) * (isRear ? rt : ft);
      const readings = tireTemperatureReadings(frame, index, side, config.temperatureSemanticId, config.temperatureSemanticId === "tire.temperature.core" ? "core" : config.temperatureSemanticId.includes("carcass") ? "carcass" : "surface");
      const brakeTemp = wheelValue(frame, "brakes.brake-temp", index);
      const wear = wheelValue(frame, "tires.tire-wear", index);
      const timestamp = semanticNumber(frame, "diagnostics.timestamp-ms") ?? 0;
      if (this.previousSample !== frame) {
        const dt = (timestamp - this.previousTimestamp) / 1000;
        if (dt > 0 && dt < 1) this.wearRates[index] = this.wearRates[index] * 0.9 + (this.previousWear[index] - wear) / dt * 0.1;
        this.previousWear[index] = wear;
      }
      const wheel = this.wheels[index];
      updateWheelResource(wheel, { position: [x, 0, z], steerAngle: isRear ? 0 : steering, rimColor: "var(--app-accent)", temperatureReadings: readings, temperatureThresholds: config.temperatureThresholds, brakeTemp, side, isRear, onCurb: false, puddleDepth: wheelValue(frame, "tires.wheel-in-puddle-depth", index), tireRadius: radius, tireWidth: width });
      const lockup = states[index]?.state === "lockup";
      const rotationSpeed = lockup ? 0 : visualWheelRotationSpeed(Array.isArray(measured) ? measured[index] : undefined, speed, radius, analysis.wheelRotation.source !== "unavailable");
      setWheelSpin(wheel, rotationSpeed, elapsed, source?.playbackSpeed ?? 1, !!source?.playing);
      if (config.toggles.wheelInfo && readings.length) {
        const labelConfig = { temperatureReadings: readings, fmtTemp: config.fmtTemp, temperatureThresholds: config.temperatureThresholds,
          displayBrakeTemp: config.toggles.wheelInfo && Array.isArray(brakeTemps) && typeof brakeTemps[index] === "number" ? config.fmtTemp(brakeTemps[index] as number) : null,
          wear, wearRate: this.wearRates[index], brakeTemp, pressurePsi: wheelValue(frame, "tires.tire-pressure", index), pressureOptimal: config.pressureOptimal, side, isRear };
        let label = this.labels[index];
        if (!label) {
          label = createWheelLabelResource(this.scene, labelConfig);
          wheel.root.add(label.sprite);
          this.labels[index] = label;
        }
        if (labelNow) updateWheelLabelResource(label, labelConfig, now, generation, !!source?.playing && !source.recording);
        updateWheelLabelScale(label, this.camera);
        label.sprite.visible = true;
      } else {
        const label = this.labels[index];
        if (label) label.sprite.visible = false;
      }
      if (config.toggles.springs) {
        if (!this.springs[index]) this.springs[index] = createSuspensionSpringResource(this.scene);
        const inboard = z > 0 ? z - 0.35 : z + 0.35;
        const drop = -(Number(suspension[index]) - 0.5) * stroke;
        updateSuspensionSpringResource(this.springs[index], this.camera, [x, 0.23 + drop, inboard], [x, 0, inboard], Number(suspension[index]), config.suspThresholds, viewportHeight);
        this.springs[index].spring.group.visible = true; this.springs[index].rod.group.visible = true;
      } else if (this.springs[index]) { this.springs[index].spring.group.visible = false; this.springs[index].rod.group.visible = false; }
    }
    if (this.previousSample !== frame) { this.previousSample = frame; this.previousTimestamp = semanticNumber(frame, "diagnostics.timestamp-ms") ?? 0; }
    if (config.toggles.springs) {
      const s0 = Number(suspension[0]), s1 = Number(suspension[1]), s2 = Number(suspension[2]), s3 = Number(suspension[3]);
      const base = Math.min(s0, s1, s2, s3), maximum = Math.max(s0, s1, s2, s3);
      const o0 = s0 - base, o1 = s1 - base, o2 = s2 - base, o3 = s3 - base;
      const sum = o0 + o1 + o2 + o3;
      const loadX = sum > 1e-4 ? (wb * (o0 + o1 - o2 - o3) / sum) * Math.min(1, maximum) : 0;
      const loadZ = sum > 1e-4 ? (((-ft + 0.35) * o0 + (ft - 0.35) * o1 + (-rt + 0.35) * o2 + (rt - 0.35) * o3) / sum) * Math.min(1, maximum) : 0;
      const y = 0.23 - ((s0 + s1 + s2 + s3) / 4 - 0.5) * stroke;
      this.loadDot.position.set(loadX, y, loadZ);
      this.loadDot.visible = true;
      const trail = buildLoadTrail(frames, cursorIdx, suspensionRange, wb, ft, rt);
      updateRibbonPool(this.loadTrail, this.camera, [trail.map(([x, z]) => ({ x, y, z, color: THREE_COLORS.loadDistribution, alpha: 0.55 }))], 1.2, viewportHeight);
      this.loadTrail.group.visible = true;
    } else { this.loadDot.visible = false; this.loadTrail.group.visible = false; }
    this.drivetrain.visible = config.toggles.drivetrain;
    if (config.toggles.drivetrain) {
      const positions = this.axlePositions;
      positions[0][0].set(wb, 0, -ft); positions[0][1].set(wb, 0, ft);
      positions[1][0].set(-wb, 0, -rt); positions[1][1].set(-wb, 0, rt);
      positions[2][0].set(wb, 0, 0); positions[2][1].set(-wb, 0, 0);
      for (let i = 0; i < 3; i++) updateOpaqueWideLine(this.axles[i], positions[i]);
      (this.drivetrain.children[3] as THREE.Mesh).position.x = wb;
      (this.drivetrain.children[4] as THREE.Mesh).position.x = -wb;
    }
    if (config.toggles.track && config.outline?.length) {
      if (!this.track) this.track = createTrackLineResource(this.scene);
      updateTrackLineResource(this.track, this.camera, config.outline, frame, viewportHeight, config.autoOrbit ? 80 : undefined);
      this.track.pool.group.visible = true;
    } else if (this.track) this.track.pool.group.visible = false;
    if (config.toggles.racingLine && config.boundaries?.raceLine?.length) {
      if (!this.racingLine) this.racingLine = createTrackLineResource(this.scene, THREE_COLORS.trackRacingLine, 4, 1, -0.435);
      updateTrackLineResource(this.racingLine, this.camera, config.boundaries.raceLine, frame, viewportHeight, config.autoOrbit ? 80 : undefined);
      this.racingLine.pool.group.visible = true;
    } else if (this.racingLine) this.racingLine.pool.group.visible = false;
    if (config.toggles.track && config.boundaries) {
      if (!this.boundaries) this.boundaries = createTrackBoundaryResource(this.scene);
      updateTrackBoundaryResource(this.boundaries, config.boundaries, frame, config.carModel.tireRadius, config.autoOrbit ? 80 : undefined);
      this.boundaries.left.visible = true; this.boundaries.right.visible = true;
    } else if (this.boundaries) { this.boundaries.left.visible = false; this.boundaries.right.visible = false; }
    if (config.toggles.track && frames.length) {
      if (!this.curbs) this.curbs = createCurbMarkerResource(this.scene);
      updateCurbMarkerResource(this.curbs, this.curbPoints, this.puddlePoints, frame, -config.carModel.tireRadius);
      this.curbs.curb.mesh.visible = true; this.curbs.puddle.mesh.visible = true;
    } else if (this.curbs) { this.curbs.curb.mesh.visible = false; this.curbs.puddle.mesh.visible = false; }
    if (config.toggles.trails) {
      if (!this.trail) this.trail = createTireTrailResource(this.scene, config.carModel);
      updateTireTrailResource(this.trail, frames, cursorIdx, config.gameId);
      this.trail.mesh.visible = true;
    } else if (this.trail) this.trail.mesh.visible = false;
    if (config.toggles.inputs && frames.length) {
      if (!this.inputs) this.inputs = createInputOverlayResource(this.scene);
      updateInputOverlayResource(this.inputs, this.camera, frames, frame, viewportHeight);
      this.inputs.throttle.group.visible = true; this.inputs.brake.group.visible = true;
    } else if (this.inputs) { this.inputs.throttle.group.visible = false; this.inputs.brake.group.visible = false; }
    if (config.toggles.dimensions) {
      if (!this.dimensions) this.dimensions = createDimensionLineResource(this.scene);
      updateDimensionLineResource(this.dimensions, this.camera, config.carModel, viewportHeight);
      for (const pool of this.dimensions.lines) pool.group.visible = true;
      for (const label of this.dimensions.labels) label.sprite.visible = true;
    } else if (this.dimensions) {
      for (const pool of this.dimensions.lines) pool.group.visible = false;
      for (const label of this.dimensions.labels) label.sprite.visible = false;
    }
  }

  dispose(): void {
    this.grid.dispose(); this.grid.group.removeFromParent();
    disposeRibbonPool(this.loadTrail); this.loadTrail.group.removeFromParent();
    this.loadDot.removeFromParent(); this.loadDot.geometry.dispose(); (this.loadDot.material as THREE.Material).dispose();
    for (const line of this.axles) disposeOpaqueWideLine(line);
    for (const object of this.drivetrain.children.slice(3)) {
      const box = object as THREE.Mesh;
      box.geometry.dispose();
      (box.material as THREE.Material).dispose();
    }
    this.drivetrain.removeFromParent();
    for (const label of this.labels) if (label) disposeWheelLabelResource(label);
    for (const wheel of this.wheels) disposeWheelResource(wheel);
    for (const spring of this.springs) disposeSuspensionSpringResource(spring);
    if (this.dimensions) disposeDimensionLineResource(this.dimensions);
    if (this.track) disposeTrackLineResource(this.track);
    if (this.racingLine) disposeTrackLineResource(this.racingLine);
    if (this.boundaries) disposeTrackBoundaryResource(this.boundaries);
    if (this.curbs) disposeCurbMarkerResource(this.curbs);
    if (this.trail) disposeTireTrailResource(this.trail);
    if (this.inputs) disposeInputOverlayResource(this.inputs);
  }
}
