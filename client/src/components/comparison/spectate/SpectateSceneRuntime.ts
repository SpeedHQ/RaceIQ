import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WebGPURenderer } from "three/webgpu";
import { createRibbonPool, updateRibbonPool, disposeRibbonPool, type RibbonPool, type RibbonRun } from "../../wireframe/LineResources";
import type { SpectateController, SpectatePair, SpectatePose, SpectateSample } from "./types";
import type { TrackMapBoundaries, Point } from "../../analyse/track-map/types";
import { createCarBody, type CarBodyInstance } from "../../wireframe/CarBody";
import { resolveCarModelSelection } from "../../wireframe/resolve-car-model";
import { loadCarModelConfigs } from "../../../data/car-models";
import { resolveCssColor, resolveCssFont } from "../../../lib/rendering/css-values";
import { applyAlignment, computeAlignment } from "@raceiq/shared/racing/tracks/geometry/points";
import { flipBoundaries, needsTrackFlip } from "@raceiq/shared/racing/tracks/coords";
import { controlInputPercent } from "../../../lib/vehicle-dynamics";
const color = (name: string) => resolveCssColor(`var(${name})`);
type TrackPoint = { x: number; z: number };
type TrackAlignment = NonNullable<ReturnType<typeof computeAlignment>>;
type Slot = { body: CarBodyInstance | null; generation: number };

/** Owns one renderer and shared world; each car has independent model lifecycle. */
export class SpectateSceneRuntime {
  readonly canvas: HTMLCanvasElement;
  private renderer: WebGPURenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(48, 1, 0.05, 10000);
  private controls: OrbitControls;
  private observer: ResizeObserver;
  private edgePool: RibbonPool = createRibbonPool({ depthTest: false });
  private linePools: [RibbonPool, RibbonPool] = [createRibbonPool({ depthTest: false }), createRibbonPool({ depthTest: false })];
  private edgeRuns: RibbonRun[] = [];
  private lineRuns: [RibbonRun[], RibbonRun[]] = [[], []];
  private groups: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private markers: [THREE.Sprite, THREE.Sprite];
  private modelLengths: [number, number] = [0, 0];
  private modelBoundsScratch = new THREE.Box3();
  private slots: [Slot, Slot] = [
    { body: null, generation: 0 },
    { body: null, generation: 0 },
  ];
  private track = new THREE.Group();
  private raf = 0;
  private dirty = true;
  private disposed = false;
  private initialized = false;
  private lastRender = 0;
  private unsubscribe: () => void;
  private error: (message: string) => void;
  private ready: (ready: boolean) => void;
  private pair: SpectatePair;
  private controller: SpectateController;
  private genericModels: [boolean, boolean] = [false, false];
  get hasGenericModel() {
    return this.genericModels.some(Boolean);
  }
  private origin = new THREE.Vector3();
  private fitRadius = 120;
  private settleFrames = 0;
  private userTheta = 0;
  private userPhi = Math.PI / 3;
  private targetScratch = new THREE.Vector3();
  private deltaScratch = new THREE.Vector3();
  private separationScratch = new THREE.Vector3();
  private quaternionScratch = new THREE.Quaternion();
  private sphericalScratch = new THREE.Spherical();
  private centerScratch = new THREE.Vector3();
  private sizeScratch = new THREE.Vector3();
  private positionScratch = new THREE.Vector3();
  private pointerIds = new Set<number>();
  private pointerStart = new Map<number, [number, number, number]>();
  private rotatingPointer = false;
  private pointerDown = (event: PointerEvent) => {
    this.pointerIds.add(event.pointerId);
    this.pointerStart.set(event.pointerId, [event.clientX, event.clientY, event.button]);
    this.rotatingPointer = false;
  };
  private pointerUp = (event: PointerEvent) => {
    this.pointerIds.delete(event.pointerId);
    this.pointerStart.delete(event.pointerId);
    this.rotatingPointer = false;
  };
  private pointerMove = (event: PointerEvent) => {
    if (!this.pointerIds.has(event.pointerId) || this.pointerIds.size !== 1) {
      this.rotatingPointer = false;
      return;
    }
    const start = this.pointerStart.get(event.pointerId);
    this.rotatingPointer = !!start && start[2] === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && (Math.abs(event.clientX - start[0]) > 2 || Math.abs(event.clientY - start[1]) > 2);
  };
  private fpsCap: number;
  private forceWebGL: boolean;
  private drawing = false;
  private visibilityChanged = () => {
    if (!document.hidden) this.wake();
  };
  constructor(container: HTMLElement, pair: SpectatePair, controller: SpectateController, onReady: (ready: boolean) => void, onError: (message: string) => void, forceWebGL = false, fpsCap = 30) {
    this.fpsCap = Number.isFinite(fpsCap) && fpsCap > 0 ? fpsCap : 30;
    this.forceWebGL = forceWebGL;
    this.pair = pair;
    this.controller = controller;
    this.ready = onReady;
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
    this.markers = [this.createPositionMarker("A", "--comparison-lap-a"), this.createPositionMarker("B", "--comparison-lap-b")];
    this.scene.add(light, this.track, ...this.groups, ...this.markers, this.edgePool.group, ...this.linePools.map((pool) => pool.group));
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = false;
    this.controls.enablePan = false;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 20000;
    this.controls.addEventListener("change", this.controlsChanged);
    this.canvas.addEventListener("pointerdown", this.pointerDown);
    this.canvas.addEventListener("pointerup", this.pointerUp);
    this.canvas.addEventListener("pointercancel", this.pointerUp);
    this.canvas.addEventListener("pointermove", this.pointerMove, true);
    this.observer = new ResizeObserver(() => {
      const r = container.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.camera.aspect = r.width / r.height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(r.width, r.height, false);
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
    const renderer = new WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: true, powerPreference: "high-performance", forceWebGL: this.forceWebGL });
    renderer.info.autoReset = false;
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
    const native: TrackPoint[] = [];
    for (const sample of this.pair.a.samples) {
      const x = sample.values["motion.position-x"],
        z = sample.values["motion.position-z"];
      if (typeof x === "number" && Number.isFinite(x) && typeof z === "number" && Number.isFinite(z)) native.push({ x, z });
    }
    let boundaryAlignment: TrackAlignment | null = null;
    let displayBoundaries = boundaries;
    if (displayBoundaries && needsTrackFlip(this.pair.gameId)) displayBoundaries = flipBoundaries(displayBoundaries);
    if (displayBoundaries && displayBoundaries.centerLine.length >= 5) boundaryAlignment = computeAlignment(displayBoundaries.centerLine, native);
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
    if (!validAlignment(displayBoundaries?.centerLine ?? [], boundaryAlignment)) boundaryAlignment = null;
    const outlineAlignment = computeAlignment([...(outline ?? [])], native);
    const validOutlineAlignment = validAlignment(outline ?? [], outlineAlignment) ? outlineAlignment : null;
    const transform = (points: readonly Point[], alignment: TrackAlignment) => points.map((point) => applyAlignment(point, alignment));
    const drawPoints = (points: readonly Point[], alignment: TrackAlignment, tint: string, runs: RibbonRun[]) => {
      const transformed = transform(points, alignment);
      if (transformed.length > 1)
        runs.push(transformed.map((point) => ({ x: point.x - this.origin.x, y: -this.origin.y, z: point.z - this.origin.z, color: color(tint) })));
      return Math.max(0, transformed.length - 1);
    };
    const edgeRuns: RibbonRun[] = [];
    let edgeCount = 0;
    if (displayBoundaries && boundaryAlignment) {
      for (const edge of [displayBoundaries.leftEdge, displayBoundaries.rightEdge, ...(displayBoundaries.additionalSections ?? []).flatMap((section) => [section.leftEdge, section.rightEdge])])
        edgeCount += drawPoints(edge, boundaryAlignment, "--app-text-muted", edgeRuns);
    }
    this.canvas.dataset.trackEdgeCount = String(edgeCount);
    let geometrySource = native.length > 1 ? "recorded-trace" : "unavailable";
    if (edgeCount) geometrySource = "calibrated-boundaries";
    else if (outline && outline.length > 1 && validOutlineAlignment) {
      drawPoints(outline, validOutlineAlignment, "--app-text-muted", edgeRuns);
      geometrySource = "calibrated-outline";
    }
    this.edgeRuns = edgeRuns;
    this.canvas.dataset.trackGeometrySource = geometrySource;
    const brakeColor = color("--ch-brake"),
      throttleColor = color("--ch-throttle"),
      neutralColor = color("--app-text-muted");
    const renderLap = (side: "a" | "b", index: 0 | 1, samples: readonly SpectateSample[]) => {
      let count = 0, brakeCount = 0, throttleCount = 0, neutralCount = 0, previous: SpectateSample | null = null;
      let run: Array<{ x: number; y: number; z: number; color: THREE.ColorRepresentation }> = [];
      const runs: RibbonRun[] = [];
      const flush = () => { if (run.length > 1) runs.push(run); run = []; };
      const point = (sample: SpectateSample) => {
        const x = sample.values["motion.position-x"], z = sample.values["motion.position-z"], y = sample.values["motion.position-y"];
        if (typeof x !== "number" || !Number.isFinite(x) || typeof z !== "number" || !Number.isFinite(z)) return null;
        return [x - this.origin.x, (typeof y === "number" && Number.isFinite(y) ? y : this.origin.y) - this.origin.y, z - this.origin.z] as const;
      };
      for (const sample of samples) {
        const current = point(sample), prior = previous && point(previous);
        const connected = !!previous && !!prior && !!current && previous.run === sample.run && Number.isFinite(sample.time - previous.time) && sample.time - previous.time <= 0.1 && sample.time >= previous.time;
        if (!connected) { flush(); previous = current ? sample : null; continue; }
        const brake = sample.values["inputs.brake"], accel = sample.values["inputs.accel"];
        const brakePct = typeof brake === "number" && Number.isFinite(brake) ? controlInputPercent(brake) : 0;
        const accelPct = typeof accel === "number" && Number.isFinite(accel) ? controlInputPercent(accel) : 0;
        const inputColor = brakePct > 0 ? brakeColor : accelPct > 0 ? throttleColor : neutralColor;
        if (brakePct > 0) brakeCount++; else if (accelPct > 0) throttleCount++; else neutralCount++;
        if (!run.length) run.push({ x: prior[0], y: prior[1], z: prior[2], color: neutralColor });
        run.push({ x: current[0], y: current[1], z: current[2], color: inputColor });
        count++;
        previous = sample;
      }
      flush();
      this.lineRuns[index] = runs;
      this.canvas.dataset[`${side}RacingLineSegments`] = String(count);
      this.canvas.dataset[`${side}BrakeSegments`] = String(brakeCount);
      this.canvas.dataset[`${side}ThrottleSegments`] = String(throttleCount);
      this.canvas.dataset[`${side}NeutralSegments`] = String(neutralCount);
    };
    renderLap("a", 0, this.pair.a.samples);
    renderLap("b", 1, this.pair.b.samples);
    this.wake();
  }
  private initGeneration = 0;
  private async initialize() {
    const generation = ++this.initGeneration;
    try {
      await this.renderer.init();
      if (this.disposed || generation !== this.initGeneration) return;
      await loadCarModelConfigs();
      if (this.disposed || generation !== this.initGeneration) return;
      const results = await Promise.allSettled([this.loadCar(0), this.loadCar(1)]);
      if (this.disposed || generation !== this.initGeneration) return;
      const failures = results.map((result, index) => {
        if (result.status === "rejected") this.groups[index].visible = false;
        return result.status === "rejected";
      });
      const initial = this.controller.getSnapshot();
      this.canvas.dataset.sideAState = initial.a?.pose ? "ready" : "pose-unavailable";
      this.canvas.dataset.sideBState = initial.b?.pose ? "ready" : "pose-unavailable";
      if (failures[0]) this.canvas.dataset.sideAState = "model-unavailable";
      if (failures[1]) this.canvas.dataset.sideBState = "model-unavailable";
      if (failures.every(Boolean) || (!initial.a?.pose && !initial.b?.pose)) {
        this.error(!initial.a?.pose && !initial.b?.pose ? "scene.pose-unavailable" : "scene.model-unavailable");
        return;
      }
      this.initialized = true;
      this.canvas.dataset.rendererBackend = (this.renderer.backend as typeof this.renderer.backend & { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";
      this.fit();
      this.wake();
    } catch {
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
    const lap = i ? this.pair.comparison.lapB : this.pair.comparison.lapA;
    const selection = resolveCarModelSelection(this.pair.gameId, lap.carId);
    if (!selection.model.hasModel) throw new Error("scene.model-unavailable");
    this.genericModels[i] = selection.label === "generic";
    const body = await createCarBody(selection.model, "solid", selection.model.glbOffsetX ?? 0, false, { preserveNativeWheels: true });
    if (this.disposed || gen !== slot.generation) {
      body.dispose();
      return;
    }
    body.root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        const mat = m as THREE.Material & { color?: THREE.Color };
        if (mat.color) mat.color.set(color(i ? "--comparison-lap-b" : "--comparison-lap-a"));
      }
    });
    slot.body = body;
    this.modelBoundsScratch.setFromObject(body.root).getSize(this.sizeScratch);
    this.modelLengths[i] = Math.max(this.sizeScratch.x, this.sizeScratch.z);
    this.canvas.dataset[i === 0 ? "aWheelCount" : "bWheelCount"] = String(body.root.userData.nativeWheelMeshCount ?? 0);
    this.canvas.dataset[i === 0 ? "aModelPath" : "bModelPath"] = selection.model.modelPath;
    this.groups[i].add(body.root);
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
    for (const samples of [this.pair.a.samples, this.pair.b.samples])
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
  private pose(group: THREE.Group, pose: SpectatePose | null) {
    group.visible = !!pose;
    // CarBody's canonical front is +X; Analyse's semantic yaw points [sin(yaw), cos(yaw)].
    if (pose) {
      group.position.set(pose.x - this.origin.x, pose.y - this.origin.y, pose.z - this.origin.z);
      group.rotation.set(0, pose.yaw - Math.PI / 2, 0);
    }
  }
  private wake = () => {
    this.dirty = true;
    this.settleFrames = 12;
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.draw);
  };
  private controlsChanged = () => {
    if (!this.drawing && this.rotatingPointer && this.pointerIds.size === 1) {
      this.deltaScratch.copy(this.camera.position).sub(this.controls.target);
      this.sphericalScratch.setFromVector3(this.deltaScratch);
      if (this.sphericalScratch.radius < this.fitRadius * 0.15) {
        this.userTheta = this.sphericalScratch.theta;
        this.userPhi = this.sphericalScratch.phi;
      }
    }
    this.dirty = true;
    if (!this.drawing && this.initialized && !this.raf && !this.disposed) this.raf = requestAnimationFrame(this.draw);
  };
  private draw = (now: number) => {
    this.raf = 0;
    if (this.disposed || document.hidden || !this.initialized) return;
    this.drawing = true;
    const snapshot = this.controller.getFrameSnapshot(now);
    this.pose(this.groups[0], snapshot.a?.pose ?? null);
    this.pose(this.groups[1], snapshot.b?.pose ?? null);
    const first = snapshot.a?.pose ?? null,
      second = snapshot.b?.pose ?? null;
    this.targetScratch.set(0, 0, 0);
    let poseCount = 0;
    if (first) {
      this.targetScratch.add(this.positionScratch.set(first.x - this.origin.x, first.y - this.origin.y, first.z - this.origin.z));
      poseCount++;
    }
    if (second) {
      this.targetScratch.add(this.positionScratch.set(second.x - this.origin.x, second.y - this.origin.y, second.z - this.origin.z));
      poseCount++;
    }
    if (poseCount) {
      this.deltaScratch
        .copy(this.targetScratch)
        .multiplyScalar(1 / poseCount)
        .sub(this.controls.target);
      // Replay already eases seeks. Camera lag makes moving cars surge ahead,
      // then slide backward on screen as the camera catches up.
      this.controls.target.add(this.deltaScratch);
      this.camera.position.add(this.deltaScratch);
    }
    this.controls.update();
    this.deltaScratch.copy(this.camera.position).sub(this.controls.target);
    this.sphericalScratch.setFromVector3(this.deltaScratch);
    const mix = THREE.MathUtils.smoothstep(this.sphericalScratch.radius, this.fitRadius * 0.15, this.fitRadius * 0.65);
    this.sphericalScratch.phi = THREE.MathUtils.lerp(this.userPhi, 0.002, mix);
    this.sphericalScratch.theta = THREE.MathUtils.lerp(this.userTheta, 0, mix);
    if (first && second) {
      this.separationScratch.set(second.x - first.x, second.y - first.y, second.z - first.z).applyQuaternion(this.quaternionScratch.copy(this.camera.quaternion).invert());
      const verticalHalfTangent = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      const horizontalHalfTangent = verticalHalfTangent * Math.max(this.camera.aspect, 0.25);
      const requiredDistance =
        (Math.max(Math.abs(this.separationScratch.x) / (2 * horizontalHalfTangent), Math.abs(this.separationScratch.y) / (2 * verticalHalfTangent)) + Math.abs(this.separationScratch.z) / 2) * 1.15 +
        5;
      this.sphericalScratch.radius = Math.max(this.sphericalScratch.radius, requiredDistance);
    }
    this.camera.position.setFromSpherical(this.sphericalScratch).add(this.controls.target);
    this.camera.lookAt(this.controls.target);
    this.updatePositionMarker(0, first);
    this.updatePositionMarker(1, second);
    const interval = 1000 / this.fpsCap;
    if (this.dirty && now - this.lastRender >= interval) {
      try {
        updateRibbonPool(this.edgePool, this.camera, this.edgeRuns, 1.5, Math.max(1, this.canvas.clientHeight));
        updateRibbonPool(this.linePools[0], this.camera, this.lineRuns[0], 2, Math.max(1, this.canvas.clientHeight));
        updateRibbonPool(this.linePools[1], this.camera, this.lineRuns[1], 2, Math.max(1, this.canvas.clientHeight));
        this.renderer.render(this.scene, this.camera);
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
        this.canvas.dataset.userPhi = String(this.userPhi);
        this.canvas.dataset.userTheta = String(this.userTheta);
        this.canvas.dataset.fitRadius = String(this.fitRadius);
        this.projectPose("a", first);
        this.projectPose("b", second);
        const stateA = !this.slots[0].body ? "model-unavailable" : first ? "ready" : "pose-unavailable";
        const stateB = !this.slots[1].body ? "model-unavailable" : second ? "ready" : "pose-unavailable";
        const stateChanged = this.canvas.dataset.sideAState !== stateA || this.canvas.dataset.sideBState !== stateB;
        this.canvas.dataset.sideAState = stateA;
        this.canvas.dataset.sideBState = stateB;
        if (stateChanged && this.canvas.dataset.sceneRendered === "true") this.ready(true);
        this.lastRender = now;
        this.dirty = false;
        if (this.canvas.dataset.sceneRendered !== "true") {
          this.canvas.dataset.sceneRendered = "true";
          this.ready(true);
        }
      } catch {
        this.initialized = false;
        this.drawing = false;
        this.ready(false);
        this.error("scene.renderer-init");
        return;
      }
    }
    this.drawing = false;
    if (snapshot.playing || this.settleFrames > 0 || this.dirty) {
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
  private updatePositionMarker(side: 0 | 1, pose: SpectatePose | null) {
    const marker = this.markers[side];
    const distance = Math.max(0.1, this.camera.position.distanceTo(this.groups[side].position));
    const pixelsPerMeter = Math.max(1, this.canvas.clientHeight) / (2 * distance * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
    const modelPixels = this.modelLengths[side] * pixelsPerMeter;
    marker.material.opacity = 1 - THREE.MathUtils.smoothstep(modelPixels, 14, 32);
    marker.visible = !!pose && marker.material.opacity > 0.01;
    marker.position.copy(this.groups[side].position);
    marker.position.y += 2;
    const size = 28 / pixelsPerMeter;
    marker.scale.set(size, size, 1);
    // Offset labels in camera space, never the cars or their recorded paths.
    marker.position.addScaledVector(this.positionScratch.set(0, 1, 0).applyQuaternion(this.camera.quaternion), side === 0 ? size / 2 : -size / 2);
    this.positionScratch.copy(marker.position).project(this.camera);
    this.canvas.dataset[side === 0 ? "aMarkerScreenY" : "bMarkerScreenY"] = String(this.positionScratch.y);
    this.canvas.dataset[side === 0 ? "aMarkerVisible" : "bMarkerVisible"] = String(marker.visible);
    this.canvas.dataset[side === 0 ? "aModelPixels" : "bModelPixels"] = String(modelPixels);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.initGeneration++;
    this.unsubscribe();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    this.observer.disconnect();
    this.controls.removeEventListener("change", this.controlsChanged);
    this.canvas.removeEventListener("pointerdown", this.pointerDown);
    this.canvas.removeEventListener("pointerup", this.pointerUp);
    this.canvas.removeEventListener("pointercancel", this.pointerUp);
    this.canvas.removeEventListener("pointermove", this.pointerMove, true);
    this.controls.dispose();
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.generation++;
      if (slot.body) {
        this.groups[i].remove(slot.body.root);
        slot.body.dispose();
      }
      slot.body = null;
    }
    for (const child of this.track.children)
      if (child instanceof THREE.Mesh) {
        child.geometry.dispose();
        (child.material as THREE.Material).dispose();
      }
    disposeRibbonPool(this.edgePool);
    for (const pool of this.linePools) disposeRibbonPool(pool);
    for (const marker of this.markers) {
      marker.material.map?.dispose();
      marker.material.dispose();
    }
    this.renderer.dispose();
    this.canvas.remove();
  }
}
