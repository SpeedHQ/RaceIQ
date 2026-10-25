import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WebGPURenderer } from "three/webgpu";
import { createRibbonPool, updateRibbonPool, disposeRibbonPool, type RibbonPool, type RibbonRun } from "@raceiq/scene-3d/wireframe/LineResources";
import type { ReplaySession, SpectateController, SpectatePose, SpectateReading, SpectateSample, SpectateSnapshot } from "../contracts/spectate";
import type { TrackMapBoundaries, Point } from "../contracts/host"
import type { ReplayModelResources } from "../contracts/host";
import { createCarBody, type CarBodyInstance } from "@raceiq/scene-3d/wireframe/CarBody";


import { resolveCssColor, resolveCssFont } from "@raceiq/scene-3d/rendering/css-values";
import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { flipBoundaries, needsTrackFlip } from "@raceiq/shared/racing/tracks/coords";
import { controlInputPercent } from "@raceiq/scene-3d/vehicle-dynamics";
import { SCENE_PRESENTATION } from "@raceiq/scene-3d/wireframe-utils";
import { getGame } from "@raceiq/shared/games/registry";
import { resolveAnalysisTelemetry } from "@raceiq/shared/racing/analysis/telemetry-capabilities";
import { disposeWheelResource, type WheelResource } from "@raceiq/scene-3d/wireframe/Wheel";
import { createAnalysisWheels, updateAnalysisWheels, type AnalysisWheelConfig } from "@raceiq/scene-3d/wireframe/AnalysisWheels";
import { createDrivetrainResource, type DrivetrainResource } from "@raceiq/scene-3d/wireframe/Drivetrain";
import { createWheelLabelResource, disposeWheelLabelResource, updateWheelLabelResource, updateWheelLabelScale, type WheelLabelConfig, type WheelLabelResource } from "@raceiq/scene-3d/wireframe/WheelLabels";
import { createTireTrailResource, updateTireTrailResource, disposeTireTrailResource, type TireTrailResource } from "@raceiq/scene-3d/wireframe/TireTrails";
import { createSuspensionSpringResource, disposeSuspensionSpringResource, updateSuspensionSpringResource, type SuspensionSpringResource } from "@raceiq/scene-3d/wireframe/SuspensionSpring";
import type { SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { normalizeSuspensionTravel, sceneSuspensionRange } from "@raceiq/scene-3d/suspension";
import { inputFocusColor, type SpectateFocus } from "./spectate-focus";
import { FOCUS_ZOOM_NEAR, FOCUS_ZOOM_SNAP_OUT, focusLaneWidth, focusZoomBlend, offsetFocusLane, projectFocusCenterline, sampleFocusLane, smallestAvailableModelLength, zoomIndicatorPosition, type FocusCenterPoint, type TimedFocusPoint } from "./spectate-focus-lanes";
import { sampleMotion } from "./spectate-replay";
const color = (name: string) => resolveCssColor(`var(${name})`);
import { hasTelemetryGap } from "./telemetry-gap";

export function estimatedRaceLineSegments(samples: readonly SpectateSample[], opponent = false): number[] {
  const positions: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1]!, sample = samples[i]!;
    const px = previous.values["motion.position-x"], pz = previous.values["motion.position-z"];
    const x = sample.values["motion.position-x"], z = sample.values["motion.position-z"];
    const gap = sample.time - previous.time;
    if (!Number.isFinite(previous.time) || !Number.isFinite(sample.time) || sample.time < previous.time
      || (opponent && previous.frame && sample.frame && sample.frame.sequence <= previous.frame.sequence)
      || (opponent ? gap <= 0.1 || gap > 1 : !hasTelemetryGap(previous.time, sample.time) || gap > 1)
      || typeof px !== "number" || !Number.isFinite(px) || typeof pz !== "number" || !Number.isFinite(pz)
      || typeof x !== "number" || !Number.isFinite(x) || typeof z !== "number" || !Number.isFinite(z)) continue;
    positions.push(px, 0, pz, x, 0, z);
  }
  return positions;
}
export function translateEstimatedRaceLineToScene(positions: number[], origin: TrackPoint, y: number): void {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] -= origin.x;
    positions[i + 1] = y;
    positions[i + 2] -= origin.z;
  }
}

type TrackPoint = { x: number; z: number };
type TrackAlignment = NonNullable<ReturnType<typeof computeAlignment>>;
const WORLD_ALIGNMENT: TrackAlignment = { scale: 1, cos: 1, sin: 0, tx: 0, tz: 0, flipX: false, flipZ: false };
type TireInfoOptions = Pick<WheelLabelConfig, "fmtTemp" | "temperatureLabels"> & {
  pressureOptimal: readonly [WheelLabelConfig["pressureOptimal"], WheelLabelConfig["pressureOptimal"]];
};
type WheelInfoState = {
  labels: (WheelLabelResource | undefined)[];
  previousWear: (number | null)[];
  wearRates: number[];
  timestamp: number | null;
  readingTime: number | null;
  lastUpdate: number;
  labelGeneration: number;
  playing: boolean | null;
  configurationGeneration: number;
  invalidationGeneration: number;
  seekGeneration: number;
};
function wheelNumber(values: Readonly<Record<string, unknown>>, id: string, index: number): number | null {
  const entries = values[id];
  const value = Array.isArray(entries) ? entries[index] : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
export function wheelHistoryDiscontinuity(previousTime: number | null, nextTime: number, previousSeekGeneration: number, nextSeekGeneration: number): boolean {
  return previousSeekGeneration !== nextSeekGeneration || (previousTime !== null && (nextTime < previousTime || nextTime - previousTime > 1));
}
export function wheelLabelsNeedRefresh(playing: boolean, now: number, lastUpdate: number, generation: number, previousGeneration: number): boolean {
  return !playing || now - lastUpdate >= 100 || generation !== previousGeneration;
}
type Slot = { body: CarBodyInstance | null; generation: number; wheels: WheelResource[]; springs: SuspensionSpringResource[]; drivetrain: DrivetrainResource | null; wheelInfo: WheelInfoState | null; config: AnalysisWheelConfig | null };
type TrailHead = SemanticAnalysisFrame & { values: Record<string, unknown> };
type FocusRenderPoint = { x: number; y: number; z: number; color: THREE.ColorRepresentation };
type FocusNativePoint = { x: number; y: number; z: number; distance: number };
type FocusLaneSource = FocusRenderPoint & TimedFocusPoint & Pick<FocusCenterPoint, "tx" | "tz"> & { nativeX: number; nativeY: number; nativeZ: number };
export type CarModelMode = "solid" | "wire" | "hidden";
const SCHEMATIC_LINE_WIDTH = 1.5;
const SCHEMATIC_LANE_OFFSET = 3;
const SCHEMATIC_TRACK_WIDTH = 3;

/** Owns one renderer and shared world; each car has independent model lifecycle. */
export class SpectateSceneRuntime {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(SCENE_PRESENTATION.fov, 1, 0.05, 50000);
  private controls: OrbitControls;
  private observer: ResizeObserver;
  private edgePool: RibbonPool = createRibbonPool({ depthTest: false, opacity: SCENE_PRESENTATION.trackOpacity });
  private racingLinePoints = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 12), new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false }), 1);
  private estimatedLines: [THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>, THREE.LineSegments<THREE.BufferGeometry, THREE.LineDashedMaterial>] = [
    new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ depthTest: false, depthWrite: false, dashSize: 1.5, gapSize: 1 })),
    new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ depthTest: false, depthWrite: false, dashSize: 1.5, gapSize: 1 })),
  ];
  private estimatedLineCounts: [number, number] = [0, 0];
  private racingLinePositions: number[] = [];
  private dotTransform = new THREE.Object3D();
  private dotView = new THREE.Vector3();
  private dotOffset = new THREE.Vector3();
  private racingLine = false;
  setRacingLine(enabled: boolean) {
    this.racingLine = enabled;
    this.wake();
  }
  private linePools: [RibbonPool, RibbonPool] = [createRibbonPool({ depthTest: false, opacity: SCENE_PRESENTATION.inputOpacity }), createRibbonPool({ depthTest: false, opacity: SCENE_PRESENTATION.inputOpacity })];
  private centerLinePool: RibbonPool = createRibbonPool({ depthTest: false, opacity: 1 });
  private schematicLinePools: [RibbonPool, RibbonPool] = [createRibbonPool({ depthTest: false, opacity: 1 }), createRibbonPool({ depthTest: false, opacity: 1 })];
  private edgeRuns: RibbonRun[] = [];
  private lineRuns: [RibbonRun[], RibbonRun[]] = [[], []];
  private focusCenterPoints: [(FocusCenterPoint | null)[], (FocusCenterPoint | null)[]] = [[], []];
  private focusNativePoints: [FocusNativePoint[], FocusNativePoint[]] = [[], []];
  private laneHasProgress: [boolean, boolean] = [false, false];
  private zoomBlend = 0;
  private lastControlRadius = 0;
  private zoomDirection: 1 | -1 = 1;
  private zoomIdleUntil = 0;
  private zoomSnap: { from: number; to: number; start: number } | null = null;
  private pairFitRadius = 0;
  private centerLineRuns: RibbonRun[] = [];
  private projectedLaneSources: [FocusLaneSource[][], FocusLaneSource[][]] = [[], []];
  private schematicLaneRuns: [(FocusRenderPoint & TimedFocusPoint)[][], (FocusRenderPoint & TimedFocusPoint)[][]] = [[], []];
  private focusLaneAvailable = false;
  private schematicLinesActive = false;
  private focus: SpectateFocus | null = null;
  setFocus(focus: SpectateFocus) {
    this.focus = focus;
    this.canvas.dataset.focusMode = focus.mode;
    this.rebuildLines();
    this.wake();
  }
  private groups: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private markers: [THREE.Sprite, THREE.Sprite];
  private tireTrails = false;
  private trails: [TireTrailResource | null, TireTrailResource | null] = [null, null];
  private trailFrames: [SemanticAnalysisFrame[], SemanticAnalysisFrame[]] = [[], []];
  private trailHeads: [TrailHead, TrailHead] = [
    { values: {}, states: {}, freshness: {} },
    { values: {}, states: {}, freshness: {} },
  ];
  setTireTrails(enabled: boolean) {
    this.tireTrails = enabled;
    this.wake();
  }
  private modelLengths: [number, number] = [0, 0];
  private modelBoundsScratch = new THREE.Box3();
  private springBodyScratch = new THREE.Vector3();
  private springWheelScratch = new THREE.Vector3();
  private slots: [Slot, Slot] = [
    { body: null, generation: 0, wheels: [], springs: [], drivetrain: null, wheelInfo: null, config: null },
    { body: null, generation: 0, wheels: [], springs: [], drivetrain: null, wheelInfo: null, config: null },
  ];
  private track = new THREE.Group();
  private raf = 0;
  private pendingFrames: { index: number; targetTime: number | null; resolve: () => void; reject: (error: Error) => void }[] = [];
  private resumePlaybackAfterFrames = false;
  private frameError: Error | null = null;
  private captureTarget: THREE.RenderTarget | null = null;
  private captureCanvas: OffscreenCanvas | null = null;
  private captureImageData: ImageData | null = null;
  private lastWheelUpdate = 0;
  private dirty = true;
  private disposed = false;
  private initialized = false;
  private lastRender = 0;
  private pendingWidth = 0;
  private pendingHeight = 0;
  private resizePending = false;
  private unsubscribe: () => void;
  private error: (message: string) => void;
  private ready: (ready: boolean) => void;
  private pair: ReplaySession;
  private controller: SpectateController;
  private genericModels: [boolean, boolean] = [false, false];
  get hasGenericModel() {
    return this.genericModels[0] || (!!this.pair.b && this.genericModels[1]);
  }
  private origin = new THREE.Vector3();
  private fitRadius = 120;
  private settleFrames = 0;
  private directionLock = false;
  private carModelMode: CarModelMode = "solid";
  private tireInfo = false;
  private tireInfoOptions: TireInfoOptions | null = null;
  private tireInfoGeneration = 0;
  setTireInfo(enabled: boolean, options: TireInfoOptions) {
    this.tireInfo = enabled;
    this.tireInfoOptions = options;
    this.tireInfoGeneration++;
    this.wake();
  }
  setDirectionLock(enabled: boolean) {
    this.directionLock = enabled;
    this.wake();
  }
  setCarModelMode(mode: CarModelMode) {
    if (mode === this.carModelMode) {
      this.canvas.dataset.carModelMode = mode;
      return;
    }
    this.carModelMode = mode;
    this.canvas.dataset.carModelMode = mode;
    if (mode === "hidden" || !this.initialized) {
      this.wake();
      return;
    }
    const loads = [this.loadCar(0)];
    if (this.pair.b) loads.push(this.loadCar(1));
    void Promise.allSettled(loads).then((results) => {
      if (this.disposed) return;
      const failed = results.map((result, index) => {
        if (result.status !== "rejected") return false;
        this.groups[index]!.visible = false;
        return true;
      });
      if (failed.some(Boolean)) this.error("scene.model-unavailable");
      this.wake();
    });
  }
  private targetScratch = new THREE.Vector3();
  private deltaScratch = new THREE.Vector3();
  private separationScratch = new THREE.Vector3();
  private quaternionScratch = new THREE.Quaternion();
  private sphericalScratch = new THREE.Spherical();
  private centerScratch = new THREE.Vector3();
  private laneRight = new THREE.Vector3();
  private laneUp = new THREE.Vector3();
  private laneOffset = new THREE.Vector3();
  private sizeScratch = new THREE.Vector3();
  private positionScratch = new THREE.Vector3();
  private zoomIndicator: (position: number, available: boolean) => void;
  private lastZoomIndicatorPosition = -1;
  private lastZoomIndicatorAvailable = false;
  private fpsCap: number;
  private forceWebGL: boolean;
  private readonly resources: ReplayModelResources;
  private drawing = false;
  private visibilityChanged = () => {
    if (!document.hidden) this.wake();
  };
  constructor(container: HTMLElement, pair: ReplaySession, controller: SpectateController, onReady: (ready: boolean) => void, onError: (message: string) => void, zoomIndicator: (position: number, available: boolean) => void, forceWebGL = false, fpsCap = 30, resources: ReplayModelResources) {
    this.resources = resources;
    this.fpsCap = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 30;
    this.forceWebGL = forceWebGL;
    this.pair = pair;
    this.controller = controller;
    this.ready = onReady;
    this.zoomIndicator = zoomIndicator;
    this.error = onError;
    const initialPoses = [controller.getSnapshot().a?.pose, controller.getSnapshot().b?.pose].filter((pose): pose is SpectatePose => !!pose);
    if (initialPoses.length)
      this.origin.set(
        initialPoses.reduce((sum, pose) => sum + pose.x, 0) / initialPoses.length,
        initialPoses.reduce((sum, pose) => sum + pose.y, 0) / initialPoses.length,
        initialPoses.reduce((sum, pose) => sum + pose.z, 0) / initialPoses.length,
      );
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none";
    container.append(this.canvas);
    this.renderer = this.createRenderer();
    this.scene.add(new THREE.HemisphereLight(color("--app-text"), color("--app-surface"), 2));
    const light = new THREE.DirectionalLight(color("--app-text"), 2);
    light.position.set(5, 12, 8);
    this.markers = [this.createPositionMarker(pair.b ? "A" : "", pair.b ? "--comparison-lap-a" : "--app-accent"), this.createPositionMarker("B", "--comparison-lap-b")];
    // Depth testing is disabled: the backbone must paint before both focus lanes.
    // Camera-dependent transparent sorting otherwise covers either lane while zooming.
    this.centerLinePool.group.renderOrder = -1;
    this.scene.add(light, this.track, ...this.groups, ...this.markers, this.edgePool.group, ...this.linePools.map((pool) => pool.group));
    this.scene.add(this.centerLinePool.group, ...this.schematicLinePools.map((pool) => pool.group));
    this.scene.add(this.racingLinePoints);
    this.scene.add(...this.estimatedLines);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enablePan = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 20000;
    this.controls.addEventListener("change", this.controlsChanged);
    this.observer = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.camera.aspect = r.width / r.height;
        this.camera.updateProjectionMatrix();
        this.pendingWidth = r.width;
        this.pendingHeight = r.height;
        this.resizePending = true;
        this.wake();
      }
    });
    this.observer.observe(container);
    document.addEventListener("visibilitychange", this.visibilityChanged);
    this.unsubscribe = controller.subscribe(this.wake);
    this.setOutline(null);
    void this.initialize();
  }
  private createRenderer() {
    const renderer = new WebGPURenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: "high-performance", forceWebGL: this.forceWebGL });
    renderer.info.autoReset = false;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    return renderer;
  }
  private outlineSource: readonly TrackPoint[] | null | undefined;
  private boundariesSource: TrackMapBoundaries | null | undefined;
  setOutline(outline: readonly TrackPoint[] | null, boundaries?: TrackMapBoundaries | null) {
    if (this.outlineSource === outline && this.boundariesSource === boundaries) return;
    this.outlineSource = outline;
    this.boundariesSource = boundaries;
    this.edgeRuns = [];
    this.lineRuns = [[], []];
    const racingLinePositions: number[] = [];
    const native: TrackPoint[] = [];
    for (const sample of this.pair.a.samples) {
      const x = sample.values["motion.position-x"],
        z = sample.values["motion.position-z"];
      if (typeof x === "number" && Number.isFinite(x) && typeof z === "number" && Number.isFinite(z)) native.push({ x, z });
    }
    let displayBoundaries = boundaries;
    if (displayBoundaries && needsTrackFlip(this.pair.gameId)) displayBoundaries = flipBoundaries(displayBoundaries);
    // These endpoints already return game-world metres. Fitting their centerline
    // to a driven lap moves the track toward the car and changes its scale.
    const worldBoundaries = displayBoundaries?.coordSystem === "forza" || displayBoundaries?.coordSystem === "f1-2025" || displayBoundaries?.coordSystem === "acc" || displayBoundaries?.coordSystem === "lmu";
    let boundaryAlignment: TrackAlignment | null = worldBoundaries ? WORLD_ALIGNMENT : null;
    if (!worldBoundaries && displayBoundaries && displayBoundaries.centerLine.length >= 5) boundaryAlignment = computeAlignment(displayBoundaries.centerLine, native);
    const validAlignment = (source: readonly TrackPoint[], alignment: TrackAlignment | null) => {
      if (!alignment || source.length < 5 || native.length < 5) return false;
      let minX = Infinity,
        maxX = -Infinity,
        minZ = Infinity,
        maxZ = -Infinity;
      for (const p of native) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      let error = 0,
        checks = 0;
      for (let i = 0; i < source.length; i += Math.max(1, Math.floor(source.length / 100))) {
        const p = applyAlignment(source[i]!, alignment);
        let nearest = Infinity;
        for (let j = 0; j < native.length; j += Math.max(1, Math.floor(native.length / 1000))) nearest = Math.min(nearest, Math.hypot(p.x - native[j]!.x, p.z - native[j]!.z));
        error += nearest;
        checks++;
      }
      return checks > 0 && error / checks <= Math.max(5, Math.max(maxX - minX, maxZ - minZ) * 0.025);
    };
    if (!worldBoundaries && !validAlignment(displayBoundaries?.centerLine ?? [], boundaryAlignment)) boundaryAlignment = null;
    // LMU's outline is also native world geometry, including when limits are absent.
    const outlineAlignment = this.pair.gameId === "lmu" ? WORLD_ALIGNMENT : computeAlignment([...(outline ?? [])], native);
    const validOutlineAlignment = this.pair.gameId === "lmu" || validAlignment(outline ?? [], outlineAlignment) ? outlineAlignment : null;
    const transform = (points: readonly Point[], alignment: TrackAlignment) => points.map((point) => applyAlignment(point, alignment));
    const drawPoints = (points: readonly Point[], alignment: TrackAlignment, tint: string, runs: RibbonRun[], dashed = true) => {
      const transformed = transform(points, alignment);
      const tintColor = color(tint);
      let distance = 0, run: RibbonRun[number][] = [], count = 0;
      const add = (x: number, z: number, alpha: number) => {
        const localX = x - this.origin.x, localZ = z - this.origin.z, previous = run.at(-1);
        if (previous?.x === localX && previous.z === localZ && previous.alpha === alpha) return;
        run.push({ x: localX, y: -this.origin.y, z: localZ, color: tintColor, alpha });
      };
      for (let i = 1; i < transformed.length; i++) {
        const a = transformed[i - 1]!, b = transformed[i]!;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(length) || length === 0) continue;
        let offset = 0;
        while (offset < length) {
          const phase = dashed ? distance % 7 : 0;
          const step = dashed ? Math.min(length - offset, (phase < 6 ? 6 : 7) - phase) : length - offset;
          const alpha = !dashed || phase < 6 ? 1 : 0;
          add(a.x + (b.x - a.x) * offset / length, a.z + (b.z - a.z) * offset / length, alpha);
          offset += step;
          distance += step;
          add(a.x + (b.x - a.x) * offset / length, a.z + (b.z - a.z) * offset / length, alpha);
          count++;
        }
      }
      if (run.length > 1) runs.push(run);
      return count;
    };
    const edgeRuns: RibbonRun[] = [];
    let edgeCount = 0;
    if (displayBoundaries && boundaryAlignment) {
      for (const edge of [displayBoundaries.leftEdge, displayBoundaries.rightEdge, ...(displayBoundaries.additionalSections ?? []).flatMap((section) => [section.leftEdge, section.rightEdge])])
        edgeCount += drawPoints(edge, boundaryAlignment, "--app-text", edgeRuns);
    }
    if (displayBoundaries?.raceLine && boundaryAlignment) {
      const points = transform(displayBoundaries.raceLine, boundaryAlignment);
      // Uniform metre spacing avoids clustering dots where source points are dense.
      let nextDot = 0;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1]!, b = points[i]!;
        const length = Math.hypot(b.x - a.x, b.z - a.z);
        if (!Number.isFinite(length) || length === 0) continue;
        while (nextDot < length) {
          const fraction = nextDot / length;
          racingLinePositions.push(a.x + (b.x - a.x) * fraction - this.origin.x, -this.origin.y, a.z + (b.z - a.z) * fraction - this.origin.z);
          nextDot += 3;
        }
        nextDot -= length;
      }
    }
    this.racingLinePositions = racingLinePositions;
    const previousDots = this.racingLinePoints;
    this.scene.remove(previousDots);
    previousDots.dispose();
    this.racingLinePoints = new THREE.InstancedMesh(previousDots.geometry, previousDots.material, Math.max(1, racingLinePositions.length / 3));
    this.racingLinePoints.count = racingLinePositions.length / 3;
    this.racingLinePoints.frustumCulled = false;
    this.racingLinePoints.material.color.set(color("--track-racing-line"));
    this.scene.add(this.racingLinePoints);
    this.canvas.dataset.trackRacingLineDots = String(racingLinePositions.length / 3);
    this.canvas.dataset.trackEdgeCount = String(edgeCount);
    let geometrySource = native.length > 1 ? "recorded-trace" : "unavailable";
    if (edgeCount) geometrySource = "calibrated-boundaries";
    else if (outline && outline.length > 1 && validOutlineAlignment) {
      drawPoints(outline, validOutlineAlignment, "--app-text", edgeRuns, false);
      geometrySource = "calibrated-outline";
    }
    this.focusLaneAvailable = false;
    this.focusCenterPoints = [[], []];
    this.focusNativePoints = [[], []];
    this.centerLineRuns = [];
    if (displayBoundaries && boundaryAlignment && displayBoundaries.centerLine.length > 1) {
      const centerLine = transform(displayBoundaries.centerLine, boundaryAlignment);
      const center = centerLine.map((point) => ({ x: point.x - this.origin.x, y: -this.origin.y, z: point.z - this.origin.z, color: color("--app-border") }));
      if (center.length > 1) this.centerLineRuns = [center];
      const project = (lap: ReplaySession["a"], side: 0 | 1) => {
        const points = lap.samples.map((sample): FocusNativePoint => {
          const motion = lap.motionSamples ? sampleMotion(lap.motionSamples, sample.time, true, "opponentLapId" in lap.replay) : null;
          const pose = motion?.pose;
          const x = sample.values["motion.position-x"], y = "opponentLapId" in lap.replay ? 0 : sample.values["motion.position-y"], z = sample.values["motion.position-z"];
          return {
            x: lap.motionSamples ? pose?.x ?? NaN : typeof x === "number" ? x : NaN,
            y: lap.motionSamples ? pose?.y ?? NaN : typeof y === "number" && Number.isFinite(y) ? y : this.origin.y,
            z: lap.motionSamples ? pose?.z ?? NaN : typeof z === "number" ? z : NaN,
            distance: motion?.distance ?? sample.distance,
          };
        });
        this.focusNativePoints[side] = points;
        return projectFocusCenterline(points, centerLine);
      };
      this.focusCenterPoints = this.pair.b ? [project(this.pair.a, 0), project(this.pair.b, 1)] : [project(this.pair.a, 0), []];
      this.focusLaneAvailable = this.focusCenterPoints.some((points) => points.some(Boolean));
    }
    this.canvas.dataset.focusLaneAvailable = String(this.focusLaneAvailable);
    this.edgeRuns = edgeRuns;
    this.canvas.dataset.trackGeometrySource = geometrySource;
    this.rebuildLines();
    this.wake();
  }
  private rebuildLines() {
    const palette = new Map<string, THREE.ColorRepresentation>();
    const focusColor = (sample: SpectateSample) => {
      const token = this.focus ? this.focus.color(sample) : inputFocusColor(sample);
      let resolved = palette.get(token);
      if (!resolved) { resolved = color(token); palette.set(token, resolved); }
      return resolved;
    };
    const nativePoint = (sample: SpectateSample, opponent: boolean): FocusRenderPoint => {
      const y = sample.values["motion.position-y"];
      return {
        x: (sample.values["motion.position-x"] as number) - this.origin.x,
        y: (opponent ? 0 : typeof y === "number" && Number.isFinite(y) ? y : this.origin.y) - this.origin.y,
        z: (sample.values["motion.position-z"] as number) - this.origin.z,
        color: focusColor(sample),
      };
    };
    const lanePoint = (point: FocusCenterPoint, sample: SpectateSample, native: FocusNativePoint): FocusLaneSource => ({
      x: point.x - this.origin.x, y: -this.origin.y, z: point.z - this.origin.z,
      nativeX: native.x - this.origin.x, nativeY: native.y - this.origin.y, nativeZ: native.z - this.origin.z,
      tx: point.tx, tz: point.tz, time: sample.time, endTime: sample.time,
      distance: native.distance, endDistance: native.distance, color: focusColor(sample),
    });
    const renderLap = (side: "a" | "b", index: 0 | 1, samples: readonly SpectateSample[]) => {
      const opponent = side === "a"
        ? "kind" in this.pair.comparison.lapA && this.pair.comparison.lapA.kind === "opponent"
        : !!this.pair.comparison.lapB && "kind" in this.pair.comparison.lapB && this.pair.comparison.lapB.kind === "opponent";
      const estimated = estimatedRaceLineSegments(samples, opponent);
      this.canvas.dataset[`${side}EstimatedRacingLineSegments`] = String(estimated.length / 6);
      const recorded: RibbonRun[] = [], projected: FocusLaneSource[][] = [];
      let native: FocusRenderPoint[] = [], lane: FocusLaneSource[] = [];
      let prior: SpectateSample | null = null, priorCenter: FocusCenterPoint | null = null;
      let nativeCount = 0, laneCount = 0, brakeCount = 0, throttleCount = 0, neutralCount = 0;
      const flushNative = () => { if (native.length > 1) recorded.push(native); native = []; };
      const flushLane = () => { if (lane.length > 1) projected.push(lane); lane = []; };
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i], center = this.focusCenterPoints[index]?.[i] ?? null;
        const x = sample.values["motion.position-x"], z = sample.values["motion.position-z"];
        const valid = typeof x === "number" && Number.isFinite(x) && typeof z === "number" && Number.isFinite(z);
        const connected = prior && valid && prior.run === sample.run && sample.time >= prior.time && sample.time - prior.time <= (opponent ? 0.3 : 0.1);
        if (prior && connected) {
          if (!native.length) native.push(nativePoint(prior, opponent));
          native.push(nativePoint(sample, opponent));
          nativeCount++;
          const brake = sample.values["inputs.brake"], throttle = sample.values["inputs.accel"];
          if (typeof brake === "number" && Number.isFinite(brake) && controlInputPercent(brake) > 0) brakeCount++;
          else if (typeof throttle === "number" && Number.isFinite(throttle) && controlInputPercent(throttle) > 0) throttleCount++;
          else neutralCount++;
        } else flushNative();
        if (prior && connected && priorCenter && center) {
          if (!lane.length) lane.push(lanePoint(priorCenter, prior, this.focusNativePoints[index][i - 1]));
          const last = lane[lane.length - 1];
          const px = center.x - this.origin.x, pz = center.z - this.origin.z;
          if ((last.x - px) ** 2 + (last.z - pz) ** 2 > 1e-16) {
            lane.push(lanePoint(center, sample, this.focusNativePoints[index][i]));
            laneCount++;
          } else {
            last.color = focusColor(sample);
            last.tx = center.tx; last.tz = center.tz;
            last.endTime = sample.time;
            last.endDistance = this.focusNativePoints[index][i].distance;
          }
        } else flushLane();
        prior = valid ? sample : null;
        priorCenter = center;
      }
      flushNative(); flushLane();
      this.canvas.dataset[`${side}RacingLineSegments`] = String(nativeCount);
      this.canvas.dataset[`${side}BrakeSegments`] = String(brakeCount);
      this.canvas.dataset[`${side}ThrottleSegments`] = String(throttleCount);
      this.canvas.dataset[`${side}NeutralSegments`] = String(neutralCount);
      this.canvas.dataset[`${side}FocusLaneSegments`] = String(laneCount);
      this.canvas.dataset[`${side}LineSegments`] = String(nativeCount);
      return { recorded, projected, laneCount, estimated };
    };
    const a = renderLap("a", 0, this.pair.a.samples), b = this.pair.b ? renderLap("b", 1, this.pair.b.samples) : { recorded: [], projected: [], laneCount: 0, estimated: [] };
    for (const [index, lap] of [a, b].entries()) {
      const line = this.estimatedLines[index]!;
      const positions = lap.estimated;
      translateEstimatedRaceLineToScene(positions, this.origin, -this.origin.y);
      line.geometry.dispose();
      line.geometry = new THREE.BufferGeometry();
      line.geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      line.computeLineDistances();
      line.material.color.set(color(index === 0 ? "--comparison-lap-a" : "--comparison-lap-b"));
      this.estimatedLineCounts[index] = positions.length / 6;
      this.canvas.dataset[`${index === 0 ? "a" : "b"}EstimatedRacingLineSegments`] = String(this.estimatedLineCounts[index]);
    }
    this.canvas.dataset.estimatedRacingLineSegments = String(this.estimatedLineCounts[0] + this.estimatedLineCounts[1]);
    this.lineRuns = [a.recorded, b.recorded];
    this.projectedLaneSources = [a.projected, b.projected];
    this.laneHasProgress = [a.projected, b.projected].map((runs) => {
      let previous = -Infinity;
      return runs.every((run) => run.every((point) => {
        const valid = Number.isFinite(point.distance) && Number.isFinite(point.endDistance) && point.distance! >= previous && point.endDistance! >= point.distance!;
        previous = point.endDistance!;
        return valid;
      }));
    }) as [boolean, boolean];
    this.schematicLaneRuns = [
      a.projected.map((run) => run.map(({ x, y, z, color, time, endTime, distance, endDistance }) => ({ x, y, z, color, time, endTime, distance, endDistance }))),
      b.projected.map((run) => run.map(({ x, y, z, color, time, endTime, distance, endDistance }) => ({ x, y, z, color, time, endTime, distance, endDistance }))),
    ];
    this.focusLaneAvailable = this.centerLineRuns.length > 0 && a.laneCount + b.laneCount > 0;
    this.schematicLinesActive &&= this.focusLaneAvailable;
    this.canvas.dataset.focusLaneAvailable = String(this.focusLaneAvailable);
    this.wake();
  }
  private initGeneration = 0;
  private async initialize() {
    const generation = ++this.initGeneration;
    try {
      await this.renderer.init();
      if (this.disposed || generation !== this.initGeneration) return;
      await this.resources.loadCarModelConfigs();
      if (this.disposed || generation !== this.initGeneration) return;
      const loads = [this.loadCar(0)];
      if (this.pair.b) loads.push(this.loadCar(1));
      const results = await Promise.allSettled(loads);
      if (this.disposed || generation !== this.initGeneration) return;
      const failures = results.map((result, index) => {
        if (result.status === "rejected") this.groups[index]!.visible = false;
        return result.status === "rejected";
      });
      const initial = this.controller.getSnapshot();
      this.canvas.dataset.sideAState = initial.a?.pose ? "ready" : "pose-unavailable";
      if (this.pair.b) this.canvas.dataset.sideBState = initial.b?.pose ? "ready" : "pose-unavailable";
      if (failures[0]) this.canvas.dataset.sideAState = "model-unavailable";
      if (failures[1]) this.canvas.dataset.sideBState = "model-unavailable";
      if (failures.every(Boolean) || (!initial.a?.pose && (!this.pair.b || !initial.b?.pose))) {
        this.rejectPendingFrames(new Error("Scene initialization failed"));
        this.error(!initial.a?.pose && (!this.pair.b || !initial.b?.pose) ? "scene.pose-unavailable" : "scene.model-unavailable");
        return;
      }
      this.initialized = true;
      this.canvas.dataset.rendererBackend = (this.renderer.backend as typeof this.renderer.backend & { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";
      this.fit();
      this.startNextFrameRequest();
      this.wake();
    } catch {
      this.rejectPendingFrames(new Error("Scene initialization failed"));
      if (!this.disposed) {
        this.initialized = false;
        this.error("scene.renderer-init");
      }
    }
  }
  private async loadCar(i: 0 | 1) {
    const slot = this.slots[i],
      gen = ++slot.generation;
    if (slot.body) {
      this.groups[i].remove(slot.body.root);
      slot.body.dispose();
      slot.body = null;
    }
    slot.drivetrain?.dispose();
    slot.drivetrain = null;
    if (slot.wheelInfo) for (const label of slot.wheelInfo.labels) if (label) disposeWheelLabelResource(label);
    slot.wheelInfo = null;
    for (const wheel of slot.wheels) disposeWheelResource(wheel);
    slot.wheels = [];
    for (const spring of slot.springs) disposeSuspensionSpringResource(spring);
    slot.springs = [];
    slot.config = null;
    if (this.trails[i]) disposeTireTrailResource(this.trails[i]);
    this.trails[i] = null;
    const lap = i ? this.pair.b && this.pair.comparison.lapB : this.pair.comparison.lapA;
    if (!lap) return;
    const selection = this.resources.resolveCarModelSelection(this.pair.gameId, lap.carId);
    if (!selection.model.hasModel) throw new Error("scene.model-unavailable");
    this.genericModels[i] = selection.label === "generic";
    const body = await createCarBody(selection.model, this.carModelMode === "hidden" ? "solid" : this.carModelMode, selection.model.glbOffsetX ?? 0, true);
    if (this.disposed || gen !== slot.generation) {
      body.dispose();
      return;
    }
    if (this.pair.b) body.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const mat = m as THREE.Material & { color?: THREE.Color };
        if (mat.color) mat.color.set(color(i ? "--comparison-lap-b" : "--comparison-lap-a"));
      }
    });
    slot.body = body;
    this.modelBoundsScratch.setFromObject(body.root).getSize(this.sizeScratch);
    const modelLength = Math.max(this.sizeScratch.x, this.sizeScratch.z);
    if (Number.isFinite(modelLength) && modelLength > 0) this.modelLengths[i] = modelLength;
    const adapter = getGame(this.pair.gameId);
    const temperature = resolveAnalysisTelemetry(adapter).tireTemperature;
    slot.config = {
      carModel: selection.model,
      gameId: this.pair.gameId,
      temperatureSemanticId: temperature.source !== "unavailable" && temperature.binding?.kind === "value"
        ? temperature.binding.semanticId : "tire.temperature.surface.representative",
      temperatureThresholds: adapter.tireTempThresholds,
    };
    slot.wheels = createAnalysisWheels(this.groups[i], selection.model);
    slot.springs = Array.from({ length: 4 }, () => createSuspensionSpringResource(this.scene));
    for (const spring of slot.springs) spring.spring.group.visible = spring.rod.group.visible = false;
    slot.drivetrain = createDrivetrainResource();
    slot.drivetrain.update(selection.model);
    this.groups[i].add(slot.drivetrain.root);
    this.canvas.dataset[i === 0 ? "aWheelCount" : "bWheelCount"] = String(slot.wheels.length);
    this.canvas.dataset[i === 0 ? "aModelPath" : "bModelPath"] = selection.model.modelPath;
    this.groups[i].add(body.root);
  }
  private updateWheels(side: 0 | 1, reading: SpectateReading | null, elapsed: number, speed: number, playing: boolean, now: number, seekGeneration: number) {
    const slot = this.slots[side];
    if (!reading || !slot.config) return;
    const frame: SemanticAnalysisFrame = { values: reading.values, states: {}, freshness: {} };
    if (slot.body) {
      const normalized = reading.values["suspension.norm-suspension-travel"];
      const native = Array.isArray(normalized) && normalized.length >= 4 && normalized.slice(0, 4).every(value => typeof value === "number" && Number.isFinite(value));
      const raw = reading.values["suspension.suspension-travel-m"];
      const lap = side === 0 ? this.pair.a : this.pair.b;
      const suspension = native ? normalized as number[]
        : Array.isArray(raw) && raw.length >= 4 && raw.slice(0, 4).every(value => typeof value === "number" && Number.isFinite(value)) && lap
          ? normalizeSuspensionTravel(raw, sceneSuspensionRange(lap.samples, this.pair.gameId)) : null;
      const [fl, fr, rl, rr] = suspension ?? [0.5, 0.5, 0.5, 0.5];
      const stroke = slot.config.carModel.suspStroke ?? 0.08;
      slot.body.root.position.y = -((fl! + fr! + rl! + rr!) / 4 - 0.5) * stroke;
      slot.body.root.rotation.x = ((fr! + rr! - fl! - rl!) / 2) * 0.1;
      slot.body.root.rotation.z = ((fl! + fr! - rl! - rr!) / 2) * 0.06;
      const model = slot.config.carModel;
      const thresholds = getGame(this.pair.gameId).suspensionThresholds.values;
      this.groups[side].updateMatrixWorld(true);
      for (let index = 0; index < slot.springs.length; index++) {
        const spring = slot.springs[index]!;
        spring.spring.group.visible = spring.rod.group.visible = suspension !== null && this.groups[side].visible;
        if (!suspension) continue;
        const rear = index >= 2;
        const x = rear ? -model.halfWheelbase : model.halfWheelbase;
        const z = (index % 2 === 0 ? -1 : 1) * ((rear ? model.halfRearTrack : model.halfFrontTrack) - 0.35);
        const travel = suspension[index]!;
        this.springBodyScratch.set(x, 0.23 - (travel - 0.5) * stroke, z);
        this.springWheelScratch.set(x, 0, z);
        this.groups[side].localToWorld(this.springBodyScratch);
        this.groups[side].localToWorld(this.springWheelScratch);
        updateSuspensionSpringResource(spring, this.camera,
          [this.springBodyScratch.x, this.springBodyScratch.y, this.springBodyScratch.z],
          [this.springWheelScratch.x, this.springWheelScratch.y, this.springWheelScratch.z],
          travel, thresholds, Math.max(1, this.canvas.clientHeight));
      }
    }
    const readings = updateAnalysisWheels(slot.wheels, frame, slot.config, elapsed, speed, playing);
    const options = this.tireInfoOptions;
    if (!this.tireInfo || !options) {
      if (slot.wheelInfo) for (const label of slot.wheelInfo.labels) if (label) label.sprite.visible = false;
      return;
    }
    const info = slot.wheelInfo ??= {
      labels: [], previousWear: [null, null, null, null], wearRates: [0, 0, 0, 0],
      timestamp: null, readingTime: null, lastUpdate: -Infinity, labelGeneration: -1, playing: null,
      configurationGeneration: this.tireInfoGeneration, invalidationGeneration: 0, seekGeneration,
    };
    const discontinuity = wheelHistoryDiscontinuity(info.readingTime, reading.time, info.seekGeneration, seekGeneration);
    const stateChanged = info.playing !== null && playing !== info.playing;
    if (discontinuity) {
      info.timestamp = null;
      info.previousWear.fill(null);
      info.wearRates.fill(0);
    }
    if (discontinuity || stateChanged || info.configurationGeneration !== this.tireInfoGeneration) {
      info.invalidationGeneration++;
      info.configurationGeneration = this.tireInfoGeneration;
    }
    info.seekGeneration = seekGeneration;
    info.readingTime = reading.time;
    const timestamp = reading.time * 1000;
    if (timestamp !== info.timestamp) {
      const dt = info.timestamp === null ? 0 : (timestamp - info.timestamp) / 1000;
      for (let index = 0; index < slot.wheels.length; index++) {
        const wear = wheelNumber(reading.values, "tires.tire-wear", index), previous = info.previousWear[index];
        info.wearRates[index] = dt > 0 && dt < 1 && wear !== null && previous != null
          ? info.wearRates[index]! * 0.9 + (previous - wear) / dt * 0.1 : 0;
        info.previousWear[index] = wear;
      }
      info.timestamp = timestamp;
    }
    const labelGeneration = this.tireInfoGeneration + info.invalidationGeneration;
    const refresh = wheelLabelsNeedRefresh(playing, now, info.lastUpdate, labelGeneration, info.labelGeneration);
    for (let index = 0; index < slot.wheels.length; index++) {
      let label = info.labels[index];
      if (refresh) {
        const brakeTemp = wheelNumber(reading.values, "brakes.brake-temp", index);
        const config: WheelLabelConfig = {
          temperatureReadings: readings[index]!,
          carcassBands: [
            wheelNumber(reading.values, "tire.temperature.carcass.left", index),
            wheelNumber(reading.values, "tire.temperature.carcass.middle", index),
            wheelNumber(reading.values, "tire.temperature.carcass.right", index),
          ],
          fmtTemp: options.fmtTemp, temperatureLabels: options.temperatureLabels,
          temperatureThresholds: slot.config.temperatureThresholds,
          displayBrakeTemp: brakeTemp === null ? null : options.fmtTemp(brakeTemp),
          wear: wheelNumber(reading.values, "tires.tire-wear", index), wearRate: info.wearRates[index]!,
          brakeTemp, pressurePsi: wheelNumber(reading.values, "tires.tire-pressure", index),
          pressureOptimal: options.pressureOptimal[side],
          side: index % 2 === 0 ? "left" : "right", isRear: index >= 2,
        };
        if (!label) {
          label = createWheelLabelResource(this.scene, config);
          label.baseScale *= 0.6;
          slot.wheels[index]!.root.add(label.sprite);
          info.labels[index] = label;
        } else updateWheelLabelResource(label, config, now, labelGeneration, playing);
      }
      if (label) { label.sprite.visible = true; updateWheelLabelScale(label, this.camera); }
    }
    if (refresh) { info.lastUpdate = now; info.labelGeneration = labelGeneration; info.playing = playing; }
  }
  private updateTrail(side: 0 | 1, reading: SpectateReading | null) {
    let trail = this.trails[side];
    const config = this.slots[side].config;
    if (!this.tireTrails || !reading?.pose || !config) {
      if (trail) trail.mesh.visible = false;
      return;
    }
    const lap = side ? this.pair.b : this.pair.a;
    if (!lap) return;
    const samples = lap.motionSamples ?? lap.samples;
    if (!trail) this.trails[side] = trail = createTireTrailResource(this.scene, config.carModel);
    let low = 0, high = samples.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (samples[mid].time <= reading.time) low = mid + 1;
      else high = mid;
    }
    const end = low - 1;
    const next = samples[low];
    if (end < 0 || (samples[end].time < reading.time && next && next.run !== samples[end].run)) {
      trail.mesh.visible = false;
      return;
    }
    const frames = this.trailFrames[side];
    let count = 0;
    // Keep only contiguous, recorded positions. Never bridge missing data or runs.
    for (let index = end; index >= Math.max(0, end - 64); index--) {
      const sample = samples[index];
      if (sample.run !== samples[end].run ||
          !Number.isFinite(sample.values["motion.position-x"]) ||
          !Number.isFinite(sample.values["motion.position-z"]) ||
          !Number.isFinite(sample.values["motion.yaw"])) break;
      count++;
    }
    for (let index = 0; index < count; index++) {
      const values = samples[end - count + 1 + index].values;
      if (frames[index]) frames[index].values = values;
      else frames[index] = { values, states: {}, freshness: {} };
    }
    frames.length = count;
    // End the ribbon at the same interpolated pose as the rendered wheels.
    // Keep recorded history fixed in world space instead of moving it with the car.
    const head = this.trailHeads[side];
    head.values["motion.position-x"] = reading.pose.x;
    head.values["motion.position-z"] = reading.pose.z;
    head.values["motion.yaw"] = reading.pose.yaw;
    if (samples[end].time < reading.time) frames.push(head);
    updateTireTrailResource(trail, frames, frames.length - 1, this.pair.gameId);
    frames.length = count;
    trail.mesh.visible = trail.mesh.count > 0;
    if (trail.mesh.visible) {
      trail.mesh.position.set(reading.pose.x - this.origin.x, reading.pose.y - this.origin.y, reading.pose.z - this.origin.z);
      // Shared trail coordinates use forward +X and lateral +Z; replay world uses +Z forward.
      trail.mesh.rotation.y = reading.pose.yaw - Math.PI / 2;
      trail.mesh.scale.z = -1;
    }
  }
  retry = () => {
    if (this.disposed) return;
    this.error("");
    this.ready(false);
    this.canvas.dataset.sceneRendered = "false";
    this.initGeneration++;
    this.renderer.dispose();
    this.renderer = this.createRenderer();
    this.slots.forEach((slot, index) => {
      if (slot.body) {
        this.groups[index].remove(slot.body.root);
        slot.body.dispose();
        slot.body = null;
      }
    });
    void this.initialize();
  };
  private fit() {
    const box = new THREE.Box3();
    const point = this.positionScratch;
    for (const samples of [this.pair.a.samples, ...(this.pair.b ? [this.pair.b.samples] : [])])
      for (const sample of samples) {
        const x = sample.values["motion.position-x"],
          z = sample.values["motion.position-z"];
        if (typeof x === "number" && Number.isFinite(x) && typeof z === "number" && Number.isFinite(z)) box.expandByPoint(point.set(x - this.origin.x, -this.origin.y, z - this.origin.z));
      }
    if (box.isEmpty()) return;
    box.getCenter(this.centerScratch);
    box.getSize(this.sizeScratch);
    const aspect = Math.max(this.camera.aspect, 0.25);
    const halfWidth = Math.max(this.sizeScratch.x, 20) * 0.55;
    const halfDepth = Math.max(this.sizeScratch.z, 20) * 0.55;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    this.fitRadius = Math.max(20, (Math.max(halfDepth, halfWidth / aspect) / Math.tan(fov / 2)) * 1.12);
    this.controls.target.copy(this.centerScratch);
    this.camera.position.set(this.centerScratch.x, this.centerScratch.y + this.fitRadius, this.centerScratch.z + this.fitRadius * 0.002);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
  }
  private pose(group: THREE.Group, pose: SpectatePose | null, side: "a" | "b") {
    // CarBody's canonical front is +X; Analyse's semantic yaw points [sin(yaw), cos(yaw)].
    if (pose) {
      group.position.set(pose.x - this.origin.x, pose.y - this.origin.y, pose.z - this.origin.z);
      group.rotation.set(0, pose.yaw - Math.PI / 2, 0);
    }
    this.canvas.dataset[`${side}RenderedCarWorldY`] = pose ? String(group.position.y + this.origin.y) : "";
  }
  requestFrame(index: number): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Scene runtime disposed"));
    if (this.frameError) return Promise.reject(this.frameError);
    if (!Number.isInteger(index) || index < 0 || !this.pair.a.replay.envelopes[index]) return Promise.reject(new Error("Replay frame unavailable"));
    if (!this.pendingFrames.length && this.controller.getSnapshot().playing) {
      this.resumePlaybackAfterFrames = true;
      this.controller.pause();
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.pendingFrames.push({ index, targetTime: null, resolve, reject });
    this.startNextFrameRequest();
    this.wake();
    return promise;
  }
  private startNextFrameRequest() {
    const pending = this.pendingFrames[0];
    if (!this.initialized || !pending || pending.targetTime !== null || this.disposed) return;
    this.controller.seekFrame("a", pending.index);
    pending.targetTime = this.controller.getSnapshot().a?.time ?? null;
    if (pending.targetTime === null) {
      this.pendingFrames.shift()!.reject(new Error("Replay frame unavailable"));
      this.startNextFrameRequest();
      this.restorePlaybackAfterFrameRequests();
      return;
    }
    this.wake();
  }
  private settleRenderedFrame(snapshot: Pick<SpectateSnapshot, "a">) {
    const pending = this.pendingFrames[0];
    if (pending && pending.targetTime !== null && snapshot.a?.time === pending.targetTime) {
      this.pendingFrames.shift()!.resolve();
      this.startNextFrameRequest();
    }
    this.restorePlaybackAfterFrameRequests();
  }
  private restorePlaybackAfterFrameRequests() {
    if (!this.pendingFrames.length && this.resumePlaybackAfterFrames) {
      this.resumePlaybackAfterFrames = false;
      if (!this.disposed) this.controller.play();
    }
  }
  async captureBitmap(): Promise<ImageBitmap> {
    if (this.disposed || !this.initialized) throw new Error("Scene runtime unavailable");
    const width = this.canvas.width, height = this.canvas.height;
    if (!width || !height) throw new Error("Scene canvas has no dimensions");
    if (!this.captureTarget || this.captureTarget.width !== width || this.captureTarget.height !== height) {
      this.captureTarget?.dispose();
      this.captureTarget = new THREE.RenderTarget(width, height, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
    }
    if (!this.captureCanvas || this.captureCanvas.width !== width || this.captureCanvas.height !== height) {
      this.captureCanvas = new OffscreenCanvas(width, height);
      this.captureImageData = new ImageData(width, height);
    }
    const target = this.captureTarget;
    this.renderer.setRenderTarget(target);
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.renderer.setRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    if (this.disposed) throw new Error("Scene runtime disposed");
    const context = this.captureCanvas.getContext("2d");
    if (!context || !this.captureImageData) throw new Error("Unable to create scene capture canvas");
    const rowBytes = width * 4;
    const stride = pixels.length === rowBytes * height ? rowBytes : Math.ceil(rowBytes / 256) * 256;
    const destination = this.captureImageData.data;
    const topFirst = this.canvas.dataset.rendererBackend === "webgpu";
    for (let y = 0; y < height; y++) {
      const destY = topFirst ? y : height - 1 - y;
      destination.set(pixels.subarray(y * stride, y * stride + rowBytes), destY * rowBytes);
    }
    context.putImageData(this.captureImageData, 0, 0);
    return createImageBitmap(this.captureCanvas);
  }
  private rejectPendingFrames(error: Error) {
    this.frameError = error;
    for (const pending of this.pendingFrames.splice(0)) pending.reject(error);
    this.restorePlaybackAfterFrameRequests();
  }
  private wake = () => {
    this.dirty = true;
    this.settleFrames = 12;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.draw);
  };
  private controlsChanged = () => {
    const radius = this.camera.position.distanceTo(this.controls.target);
    if (!this.drawing && this.initialized && this.lastControlRadius > 0 && Math.abs(Math.log(radius / this.lastControlRadius)) > 0.000001) {
      this.zoomDirection = radius > this.lastControlRadius ? 1 : -1;
      this.zoomIdleUntil = performance.now() + 140;
      this.zoomSnap = null;
    }
    this.lastControlRadius = radius;
    this.dirty = true;
    if (!this.drawing && this.initialized && !this.raf && !this.disposed) this.raf = requestAnimationFrame(this.draw);
  };
  private draw = (now: number) => {
    this.raf = 0;
    if (this.disposed || document.hidden || !this.initialized) return;
    this.drawing = true;
    const snapshot = this.controller.getFrameSnapshot(now);
    this.pose(this.groups[0], snapshot.a?.pose ?? null, "a");
    this.pose(this.groups[1], snapshot.b?.pose ?? null, "b");
    const wheelElapsed = this.lastWheelUpdate ? (now - this.lastWheelUpdate) / 1000 : 0;
    this.lastWheelUpdate = now;
    const first = snapshot.a?.pose ?? null,
      second = snapshot.b?.pose ?? null;
    let radius = Math.max(0.1, this.camera.position.distanceTo(this.controls.target));
    const modelScale = smallestAvailableModelLength(this.modelLengths, !!first, !!second) * Math.max(1, this.canvas.clientHeight) / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    if (this.zoomIdleUntil && now >= this.zoomIdleUntil) {
      this.zoomIdleUntil = 0;
      const partial = this.focusLaneAvailable ? focusZoomBlend(modelScale / radius) : 0;
      if (partial > 0 && partial < 1) {
        const targetPixels = this.zoomDirection > 0 || this.pairFitRadius > modelScale / (FOCUS_ZOOM_NEAR * 1.01) ? FOCUS_ZOOM_SNAP_OUT * 0.99 : FOCUS_ZOOM_NEAR * 1.01;
        this.zoomSnap = { from: radius, to: THREE.MathUtils.clamp(modelScale / targetPixels, this.controls.minDistance, this.controls.maxDistance), start: now };
      }
    }
    if (this.zoomSnap) {
      const t = Math.min(1, Math.max(0, (now - this.zoomSnap.start) / 280));
      const eased = t * t * (3 - 2 * t);
      const nextRadius = Math.exp(THREE.MathUtils.lerp(Math.log(this.zoomSnap.from), Math.log(this.zoomSnap.to), eased));
      this.deltaScratch.copy(this.camera.position).sub(this.controls.target).multiplyScalar(nextRadius / radius);
      this.camera.position.copy(this.controls.target).add(this.deltaScratch);
      radius = nextRadius;
      this.lastControlRadius = radius;
      this.dirty = true;
      if (t === 1) this.zoomSnap = null;
    }
    const modelPixels = modelScale / radius;
    const zoomPosition = zoomIndicatorPosition(modelPixels);
    if (Math.abs(zoomPosition - this.lastZoomIndicatorPosition) >= 0.01 || this.lastZoomIndicatorAvailable !== this.focusLaneAvailable) {
      this.lastZoomIndicatorPosition = zoomPosition;
      this.lastZoomIndicatorAvailable = this.focusLaneAvailable;
      this.zoomIndicator(zoomPosition, this.focusLaneAvailable);
    }
    const blend = this.focusLaneAvailable ? focusZoomBlend(modelPixels) : 0;
    // Resizing or newly arriving geometry can enter the band without a wheel event.
    if (blend > 0 && blend < 1 && !this.zoomIdleUntil && !this.zoomSnap) {
      this.zoomDirection = this.zoomBlend === 1 ? 1 : this.zoomBlend === 0 ? -1 : blend >= 0.5 ? 1 : -1;
      this.zoomIdleUntil = now + 140;
    }
    this.zoomBlend = blend;
    this.targetScratch.set(0, 0, 0);
    let poseCount = 0;
    for (let side = 0; side < 2; side++) {
      const reading = side === 0 ? snapshot.a : snapshot.b;
      if (!reading?.pose) continue;
      const pose = reading.pose, byDistance = this.laneHasProgress[side] && reading.distance !== null;
      this.positionScratch.set(pose.x - this.origin.x, pose.y - this.origin.y, pose.z - this.origin.z);
      if (blend > 0 && sampleFocusLane(this.centerScratch, this.projectedLaneSources[side], byDistance ? reading.distance! : reading.time, byDistance ? "distance" : "time")) this.positionScratch.lerp(this.centerScratch, blend);
      this.targetScratch.add(this.positionScratch);
      poseCount++;
    }
    if (poseCount) {
      this.targetScratch.multiplyScalar(1 / poseCount);
      this.deltaScratch.copy(this.targetScratch).sub(this.controls.target);
      // Replay already eases seeks. Camera lag makes moving cars surge ahead,
      // then slide backward on screen as the camera catches up.
      this.controls.target.add(this.deltaScratch);
      this.camera.position.add(this.deltaScratch);
    }
    this.controls.update();
    this.deltaScratch.copy(this.camera.position).sub(this.controls.target);
    this.sphericalScratch.setFromVector3(this.deltaScratch);
    const headingPose = first ?? second;
    if (this.directionLock && headingPose) {
      const nativeHeading = headingPose.yaw + Math.PI;
      this.sphericalScratch.theta = nativeHeading;
    }
    this.pairFitRadius = 0;
    if (first && second) {
      this.separationScratch.set(second.x - first.x, second.y - first.y, second.z - first.z).applyQuaternion(this.quaternionScratch.copy(this.camera.quaternion).invert());
      const verticalHalfTangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const horizontalHalfTangent = verticalHalfTangent * Math.max(this.camera.aspect, 0.25);
      const requiredDistance =
        (Math.max(Math.abs(this.separationScratch.x) / (2 * horizontalHalfTangent), Math.abs(this.separationScratch.y) / (2 * verticalHalfTangent)) + Math.abs(this.separationScratch.z) / 2) * 1.15 +
        5;
      this.pairFitRadius = requiredDistance;
      this.sphericalScratch.radius = Math.max(this.sphericalScratch.radius, requiredDistance);
    }
    this.camera.position.setFromSpherical(this.sphericalScratch).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
    this.camera.updateMatrixWorld();
    const interval = 1000 / this.fpsCap;
    if (this.dirty && now - this.lastRender >= interval) {
      try {
        // Resizing clears the drawing buffer. Keep the last frame until this
        // FPS-capped render can replace it, including during panel transitions.
        if (this.resizePending) {
          const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
          if (this.renderer.getPixelRatio() !== pixelRatio) this.renderer.setPixelRatio(pixelRatio);
          this.renderer.setSize(this.pendingWidth, this.pendingHeight, false);
          this.resizePending = false;
        }
        const compactA = this.updatePositionMarker(0, first);
        const compactB = this.updatePositionMarker(1, second);
        const showLabels = this.focusLaneAvailable ? blend >= 0.5 : compactA || compactB;
        this.schematicLinesActive = this.focusLaneAvailable && blend > 0;
        this.markers[0].visible = showLabels && !!first;
        this.markers[1].visible = showLabels && !!second;
        this.markers[0].material.opacity = 1;
        this.markers[1].material.opacity = 1;
        this.canvas.dataset.focusLaneActive = String(this.schematicLinesActive);
        this.canvas.dataset.zoomBlend = String(blend);
        this.canvas.dataset.zoomSnapping = String(this.zoomSnap !== null);
        const nativeViewVisible = !showLabels;
        const inputWidth = focusLaneWidth(THREE.MathUtils.lerp(SCENE_PRESENTATION.inputWidth, SCHEMATIC_LINE_WIDTH, blend), modelPixels);
        this.canvas.dataset.schematicLineWidth = this.schematicLinesActive ? String(inputWidth) : "";
        this.canvas.dataset.schematicLaneOffset = this.schematicLinesActive ? String(SCHEMATIC_LANE_OFFSET * blend) : "";
        this.canvas.dataset.nativeViewVisible = String(nativeViewVisible);
        this.canvas.dataset.lineLayout = nativeViewVisible ? "recorded" : "schematic";
        this.track.visible = nativeViewVisible;
        this.groups[0].visible = !showLabels && !!first;
        this.groups[1].visible = !showLabels && !!second;
        for (let side = 0; side < this.slots.length; side++) {
          const slot = this.slots[side];
          for (const spring of slot.springs) spring.spring.group.visible = spring.rod.group.visible = nativeViewVisible && this.groups[side].visible;
          if (slot.body) slot.body.root.visible = this.carModelMode !== "hidden";
          if (slot.drivetrain) slot.drivetrain.root.visible = this.carModelMode !== "solid";
        }
        if (nativeViewVisible) {
          this.updateWheels(0, snapshot.a, wheelElapsed, snapshot.speed, snapshot.playing && !snapshot.seeking, now, snapshot.seekGeneration);
          this.updateWheels(1, snapshot.b, wheelElapsed, snapshot.speed, snapshot.playing && !snapshot.seeking, now, snapshot.seekGeneration);
        }
        this.edgePool.group.visible = blend < 1;
        this.edgePool.material.opacity = SCENE_PRESENTATION.trackOpacity * (1 - blend);
        this.centerLinePool.group.visible = blend > 0;
        this.centerLinePool.material.opacity = blend;
        if (blend < 1) updateRibbonPool(this.edgePool, this.camera, this.edgeRuns, SCENE_PRESENTATION.trackWidth, Math.max(1, this.canvas.clientHeight));
        if (blend > 0) updateRibbonPool(this.centerLinePool, this.camera, this.centerLineRuns, Math.max(1, SCHEMATIC_TRACK_WIDTH * blend), Math.max(1, this.canvas.clientHeight));
        for (const [index, line] of this.estimatedLines.entries()) {
          // Estimated opponent trajectories remain useful in schematic focus mode.
          line.visible = this.racingLine && this.estimatedLineCounts[index]! > 0;
          this.canvas.dataset[`${index === 0 ? "a" : "b"}EstimatedRacingLineVisible`] = String(line.visible);
        }
        this.canvas.dataset.estimatedRacingLineVisible = String(this.estimatedLines.some((line) => line.visible));
        this.racingLinePoints.visible = nativeViewVisible && this.racingLine && this.racingLinePositions.length > 0;
        if (this.racingLinePoints.visible) {
          this.dotView.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
          this.dotTransform.quaternion.copy(this.camera.quaternion);
          const pixelScale = 4 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)) / Math.max(1, this.canvas.clientHeight);
          // Keep gaps between 4px dots when the circuit is viewed from farther away.
          const stride = Math.max(1, Math.ceil(this.sphericalScratch.radius * pixelScale * 4 / 3));
          this.racingLinePoints.count = Math.ceil(this.racingLinePositions.length / (3 * stride));
          for (let i = 0; i < this.racingLinePoints.count; i++) {
            this.dotTransform.position.fromArray(this.racingLinePositions, i * stride * 3);
            const depth = this.dotOffset.copy(this.dotTransform.position).sub(this.camera.position).dot(this.dotView);
            this.dotTransform.scale.setScalar(depth > this.camera.near ? depth * pixelScale : 0);
            this.dotTransform.updateMatrix();
            this.racingLinePoints.setMatrixAt(i, this.dotTransform.matrix);
          }
          this.racingLinePoints.instanceMatrix.needsUpdate = true;
        }
        this.canvas.dataset.trackRacingLineVisible = String(this.racingLinePoints.visible);
        if (this.schematicLinesActive) {
          const elements = this.camera.matrixWorld.elements;
          this.laneRight.set(elements[0], elements[1], elements[2]);
          this.laneUp.set(elements[4], elements[5], elements[6]);
          const viewX = -elements[8], viewY = -elements[9], viewZ = -elements[10];
          const pixelScale = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) / (Math.max(1, this.canvas.clientHeight) * this.camera.zoom);
          for (let side = 0; side < 2; side++) {
            const sources = this.projectedLaneSources[side], outputs = this.schematicLaneRuns[side];
            for (let r = 0; r < sources.length; r++) {
              for (let p = 0; p < sources[r].length; p++) {
                const source = sources[r][p], output = outputs[r][p];
                const depth = (source.x - this.camera.position.x) * viewX + (source.y - this.camera.position.y) * viewY + (source.z - this.camera.position.z) * viewZ;
                offsetFocusLane(this.laneOffset, source, this.laneRight, this.laneUp, side === 0 ? SCHEMATIC_LANE_OFFSET : -SCHEMATIC_LANE_OFFSET, Math.max(this.camera.near, depth) * pixelScale);
                output.x = THREE.MathUtils.lerp(source.nativeX, source.x + this.laneOffset.x, blend);
                output.y = (side === 0 && "kind" in this.pair.comparison.lapA && this.pair.comparison.lapA.kind === "opponent")
                  || (side === 1 && !!this.pair.comparison.lapB && "kind" in this.pair.comparison.lapB && this.pair.comparison.lapB.kind === "opponent")
                  ? -this.origin.y
                  : THREE.MathUtils.lerp(source.nativeY, source.y + this.laneOffset.y, blend);
                output.z = THREE.MathUtils.lerp(source.nativeZ, source.z + this.laneOffset.z, blend);
              }
            }
            const marker = this.markers[side], reading = side === 0 ? snapshot.a : snapshot.b;
            const byDistance = this.laneHasProgress[side] && reading?.distance !== null && reading?.distance !== undefined;
            if (reading?.pose) sampleFocusLane(marker.position, outputs, byDistance ? reading.distance! : reading.time, byDistance ? "distance" : "time");
            // Keep a valid native pose visible when projected lane geometry is absent at this sample.
            marker.visible = showLabels && !!reading?.pose;
            const depth = (marker.position.x - this.camera.position.x) * viewX + (marker.position.y - this.camera.position.y) * viewY + (marker.position.z - this.camera.position.z) * viewZ;
            const size = 28 * Math.max(this.camera.near, depth) * pixelScale;
            marker.scale.set(size, size, 1);
          }
          if (this.trails[0]) this.trails[0].mesh.visible = false;
          if (this.trails[1]) this.trails[1].mesh.visible = false;
        } else {
          this.updateTrail(0, snapshot.a);
          this.updateTrail(1, snapshot.b);
        }
        const renderedRuns = this.schematicLinesActive ? this.schematicLaneRuns : this.lineRuns;
        this.linePools[0].group.visible = !this.schematicLinesActive;
        this.linePools[1].group.visible = !this.schematicLinesActive;
        this.schematicLinePools[0].group.visible = this.schematicLinesActive;
        this.schematicLinePools[1].group.visible = this.schematicLinesActive;
        const renderedPools = this.schematicLinesActive ? this.schematicLinePools : this.linePools;
        updateRibbonPool(renderedPools[0], this.camera, renderedRuns[0], inputWidth, Math.max(1, this.canvas.clientHeight));
        updateRibbonPool(renderedPools[1], this.camera, renderedRuns[1], inputWidth, Math.max(1, this.canvas.clientHeight));
        for (let side = 0; side < 2; side++) {
          const point = renderedRuns[side][0]?.[0];
          const position = this.estimatedLines[side]!.geometry.getAttribute("position");
          const y = point
            ? point.y + this.origin.y
            : this.estimatedLines[side]!.visible && position.count
              ? position.getY(0) + this.origin.y
              : null;
          this.canvas.dataset[side === 0 ? "aRenderedPathWorldY" : "bRenderedPathWorldY"] = y === null ? "" : String(y);
        }
        this.canvas.dataset.aTrailCount = String(this.trails[0]?.mesh.visible ? this.trails[0].mesh.count : 0);
        this.canvas.dataset.bTrailCount = String(this.trails[1]?.mesh.visible ? this.trails[1].mesh.count : 0);
        this.renderer.render(this.scene, this.camera);
        this.canvas.dataset.aMarkerVisible = String(this.markers[0].visible);
        this.canvas.dataset.bMarkerVisible = String(this.markers[1].visible);
        this.canvas.dataset.aMarkerOpacity = String(this.markers[0].material.opacity);
        this.canvas.dataset.bMarkerOpacity = String(this.markers[1].material.opacity);
        this.canvas.dataset.aCarVisible = String(this.groups[0].visible && !!this.slots[0].body?.root.visible);
        this.canvas.dataset.bCarVisible = String(this.groups[1].visible && !!this.slots[1].body?.root.visible);
        for (let side = 0; side < 2; side++) {
          let visibleWheels = 0;
          if (this.groups[side].visible) {
            for (const wheel of this.slots[side].wheels) if (wheel.root.visible) visibleWheels++;
          }
          this.canvas.dataset[side === 0 ? "aWheelVisibleCount" : "bWheelVisibleCount"] = String(visibleWheels);
          this.canvas.dataset[side === 0 ? "aChassisVisible" : "bChassisVisible"] = String(this.groups[side].visible && !!this.slots[side].drivetrain?.root.visible);
          let visibleSprings = 0;
          for (const spring of this.slots[side].springs) if (spring.spring.group.visible && spring.rod.group.visible) visibleSprings++;
          this.canvas.dataset[side === 0 ? "aSuspensionVisibleCount" : "bSuspensionVisibleCount"] = String(visibleSprings);
          const body = this.slots[side].body?.root;
          this.canvas.dataset[side === 0 ? "aBodyHeave" : "bBodyHeave"] = body ? String(body.position.y) : "";
          this.canvas.dataset[side === 0 ? "aBodyRoll" : "bBodyRoll"] = body ? String(body.rotation.x) : "";
          this.canvas.dataset[side === 0 ? "aBodyPitch" : "bBodyPitch"] = body ? String(body.rotation.z) : "";
          let visibleLabels = 0;
          const info = this.slots[side].wheelInfo;
          if (this.groups[side].visible && info) for (const label of info.labels) if (label?.sprite.visible) visibleLabels++;
          this.canvas.dataset[side === 0 ? "aTireInfoVisibleCount" : "bTireInfoVisibleCount"] = String(visibleLabels);
          const marker = this.markers[side];
          this.positionScratch.copy(marker.position).project(this.camera);
          this.canvas.dataset[side === 0 ? "aMarkerScreenX" : "bMarkerScreenX"] = marker.visible ? String(this.positionScratch.x) : "";
          this.canvas.dataset[side === 0 ? "aMarkerScreenY" : "bMarkerScreenY"] = marker.visible ? String(this.positionScratch.y) : "";
        }
        this.canvas.dataset.renderCount = String(Number(this.canvas.dataset.renderCount ?? 0) + 1);
        this.canvas.dataset.renderTime = String(snapshot.time);
        this.canvas.dataset.aX = first ? String(first.x) : "";
        this.canvas.dataset.aZ = first ? String(first.z) : "";
        this.canvas.dataset.aYaw = first ? String(first.yaw) : "";
        this.canvas.dataset.bX = second ? String(second.x) : "";
        this.canvas.dataset.bZ = second ? String(second.z) : "";
        this.canvas.dataset.bYaw = second ? String(second.yaw) : "";
        this.canvas.dataset.cameraRadius = String(this.sphericalScratch.radius);
        this.canvas.dataset.cameraPhi = String(this.sphericalScratch.phi);
        this.canvas.dataset.cameraTheta = String(this.sphericalScratch.theta);
        this.canvas.dataset.fitRadius = String(this.fitRadius);
        this.projectPose("a", first);
        this.projectPose("b", second);
        const stateA = !this.slots[0].body ? "model-unavailable" : first ? "ready" : "pose-unavailable";
        const stateB = this.pair.b ? (!this.slots[1].body ? "model-unavailable" : second ? "ready" : "pose-unavailable") : undefined;
        const stateChanged = this.canvas.dataset.sideAState !== stateA || (stateB !== undefined && this.canvas.dataset.sideBState !== stateB);
        this.canvas.dataset.sideAState = stateA;
        if (stateB !== undefined) this.canvas.dataset.sideBState = stateB;
        if (stateChanged && this.canvas.dataset.sceneRendered === "true") this.ready(true);
        this.settleRenderedFrame(snapshot);
        this.lastRender = now;
        this.dirty = this.pendingFrames.length > 0;
        if (this.canvas.dataset.sceneRendered !== "true") {
          this.canvas.dataset.sceneRendered = "true";
          this.ready(true);
        }
      } catch {
        this.rejectPendingFrames(new Error("Scene rendering failed"));
        this.initialized = false;
        this.drawing = false;
        this.ready(false);
        this.error("scene.renderer-init");
        return;
      }
    }
    this.drawing = false;
    if (snapshot.playing || this.pendingFrames.length > 0 || this.settleFrames > 0 || this.dirty || this.zoomIdleUntil > 0 || this.zoomSnap) {
      if (this.settleFrames > 0) this.settleFrames--;
      this.raf = requestAnimationFrame(this.draw);
    }
  };
  private projectPose(side: "a" | "b", pose: SpectatePose | null) {
    if (pose) this.positionScratch.set(pose.x - this.origin.x, pose.y - this.origin.y, pose.z - this.origin.z).project(this.camera);
    this.canvas.dataset[side === "a" ? "aScreenX" : "bScreenX"] = pose ? String(this.positionScratch.x) : "";
    this.canvas.dataset[side === "a" ? "aScreenY" : "bScreenY"] = pose ? String(this.positionScratch.y) : "";
    this.canvas.dataset[side === "a" ? "aScreenZ" : "bScreenZ"] = pose ? String(this.positionScratch.z) : "";
  }
  private createPositionMarker(label: string, token: string) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color(token);
    context.beginPath();
    context.arc(48, 48, 34, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = color("--app-on-filled");
    context.font = resolveCssFont("700 48px var(--font-sans)");
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, 48, 50);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    marker.renderOrder = 2;
    return marker;
  }
  private updatePositionMarker(side: 0 | 1, pose: SpectatePose | null): boolean {
    const marker = this.markers[side];
    const distance = Math.max(0.1, this.camera.position.distanceTo(this.groups[side].position));
    const pixelsPerMeter = Math.max(1, this.canvas.clientHeight) / (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const modelPixels = this.modelLengths[side] * pixelsPerMeter;
    marker.position.copy(this.groups[side].position);
    marker.position.y += 2;
    const size = 28 / pixelsPerMeter;
    marker.scale.set(size, size, 1);
    // Offset labels in camera space, never the cars or their recorded paths.
    marker.position.addScaledVector(this.positionScratch.set(0, 1, 0).applyQuaternion(this.camera.quaternion), side === 0 ? size / 2 : -size / 2);
    this.canvas.dataset[side === 0 ? "aModelPixels" : "bModelPixels"] = String(modelPixels);
    return !!pose && modelPixels <= 32;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPendingFrames(new Error("Scene runtime disposed"));
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.initGeneration++;
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.observer.disconnect();
    this.controls.removeEventListener("change", this.controlsChanged);
    this.controls.dispose();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.generation++;
      if (slot.body) {
        this.groups[i].remove(slot.body.root);
        slot.body.dispose();
      }
      slot.body = null;
      for (const wheel of slot.wheels) disposeWheelResource(wheel);
      slot.wheels = [];
      for (const spring of slot.springs) disposeSuspensionSpringResource(spring);
      slot.springs = [];
      slot.drivetrain?.dispose();
      slot.drivetrain = null;
      if (slot.wheelInfo) for (const label of slot.wheelInfo.labels) if (label) disposeWheelLabelResource(label);
      slot.wheelInfo = null;
      slot.config = null;
    }
    this.captureTarget?.dispose();
    this.captureTarget = null;
    for (const child of this.track.children)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    disposeRibbonPool(this.edgePool);
    disposeRibbonPool(this.centerLinePool);
    for (const pool of this.schematicLinePools) disposeRibbonPool(pool);
    this.racingLinePoints.geometry.dispose();
    this.racingLinePoints.dispose();
    this.racingLinePoints.material.dispose();
    for (const line of this.estimatedLines) {
      line.geometry.dispose();
      line.material.dispose();
    }
    for (const pool of this.linePools) disposeRibbonPool(pool);
    for (const trail of this.trails) if (trail) disposeTireTrailResource(trail);
    for (const marker of this.markers) {
      marker.material.map?.dispose();
      marker.material.dispose();
    }
    this.renderer.dispose();
    this.canvas.remove();
  }
}
