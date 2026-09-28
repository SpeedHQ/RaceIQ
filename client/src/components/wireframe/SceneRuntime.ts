import type { RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WebGPURenderer } from "three/webgpu";
import type { GameId } from "../../../../shared/games/ids";
import type { CarModelEnrichment } from "../../data/car-models";
import type { TelemetryVariableId } from "../../../../shared/telemetry/catalog/generated/telemetry-catalog.types";
import { recordGpuSnapshot } from "../../lib/crash-diagnostics";
import { normalizeSuspensionTravel } from "../../lib/suspension";
import { VIEW_PRESETS, type ViewPreset, type ViewToggles } from "../../lib/wireframe-data";
import { semanticNumber } from "../analyse/track-map/types";
import { createCarBody, type CarBodyInstance } from "./CarBody";
import { SceneOverlays } from "./SceneOverlays";
import type { SemanticAnalysisFrame, TrackMapBoundaries } from "../analyse/track-map/types";

export interface SceneSource {
  framesRef: RefObject<SemanticAnalysisFrame[]>;
  cursorRef: RefObject<number>;
  playing: boolean;
  playbackSpeed: number;
  seekGeneration: number;
  recording: boolean;
}

export interface SceneRuntimeConfig {
  gameId: GameId;
  frame: SemanticAnalysisFrame;
  telemetry: SemanticAnalysisFrame[];
  cursorIdx: number;
  outline: { x: number; z: number }[] | null;
  boundaries: Pick<TrackMapBoundaries, "leftEdge" | "rightEdge" | "raceLine"> | null;
  toggles: ViewToggles;
  viewPreset: ViewPreset;
  carModel: CarModelEnrichment & { hasModel: boolean };
  modelOffsetX: number;
  hideModelWheels: boolean;
  autoOrbit: boolean;
  fpsCap: number;
  fmtTemp: (temperature: number) => string;
  suspThresholds: number[];
  pressureOptimal?: { min: number; max: number };
  temperatureThresholds: { cold: number; warm: number; hot: number };
  temperatureSemanticId: TelemetryVariableId;
}

interface PendingFrame {
  generation: number;
  resolve: () => void;
  reject: (reason: Error) => void;
}

/** Sole owner of a scene canvas, renderer, camera, controls and render driver. */
export class SceneRuntime {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  private readonly fpsElement: HTMLElement | null;
  private readonly onError: (error: Error) => void;
  private source: SceneSource | null = null;
  private config: SceneRuntimeConfig | null = null;
  private ready = false;
  private disposed = false;
  private raf = 0;
  private drawing = false;
  private nextDrawAt = 0;
  private lastDrawAt = 0;
  private lastGpuLog = 0;
  private fpsStart = 0;
  private fpsFrames = 0;
  private lastSeekGeneration = -1;
  private smoothYaw = Number.NaN;
  private cameraMoving = false;
  private dirty = true;
  private pending: PendingFrame[] = [];
  private body: CarBodyInstance | null = null;
  private modelKey = "";
  private modelGeneration = 0;
  private loadingModel = false;
  private readonly bodyMotion = new THREE.Group();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private overlays: SceneOverlays | null = null;
  private labelGeneration = 0;
  private captureTarget: THREE.RenderTarget | null = null;
  private captureCanvas: OffscreenCanvas | null = null;
  private captureImageData: ImageData | null = null;
  private readonly onModelDoubleClick = (event: MouseEvent) => {
    if (!this.body) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, 1 - ((event.clientY - rect.top) / rect.height) * 2);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.body.root, true).find((entry) => (entry.object as THREE.Mesh).isMesh);
    if (hit) {
      this.body.select(hit.object as THREE.Mesh);
      this.wake();
    }
  };
  private readonly onVisibility = () => {
    this.lastDrawAt = 0;
    if (!document.hidden) this.wake();
    else this.stop();
  };
  private readonly onControlsStart = () => { this.cameraMoving = true; this.wake(); };
  private readonly onControlsEnd = () => { this.cameraMoving = false; this.wake(); };
  private readonly onControlsChange = () => { this.dirty = true; this.wake(); };

  constructor(container: HTMLElement, onError: (error: Error) => void, options?: { fpsElement?: HTMLElement | null; cameraPosition?: [number, number, number]; fov?: number; background?: THREE.ColorRepresentation; forceWebGL?: boolean }) {
    this.onError = onError;
    this.fpsElement = options?.fpsElement ?? null;
    this.canvas = document.createElement("canvas");
    this.canvas.tabIndex = -1;
    this.canvas.style.cssText = "width:100%;height:100%;display:block;outline:none;background:transparent;user-select:none;-webkit-tap-highlight-color:transparent";
    container.append(this.canvas);
    this.camera = new THREE.PerspectiveCamera(options?.fov ?? 50, 1, 0.1, 3000);
    this.camera.position.set(...(options?.cameraPosition ?? [4, 2.5, 4]));
    this.renderer = new WebGPURenderer({ canvas: this.canvas, antialias: false, alpha: true, powerPreference: "high-performance", forceWebGL: options?.forceWebGL });
    this.renderer.info.autoReset = false;
    if (options?.background !== undefined) this.scene.background = new THREE.Color(options.background);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(5, 8, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.2);
    fill.position.set(-3, 4, -2);
    this.scene.add(fill);
    this.scene.add(this.bodyMotion);
    this.canvas.addEventListener("dblclick", this.onModelDoubleClick);
    this.renderer.onDeviceLost = () => { if (!this.disposed) this.fail(new Error("3D graphics device lost")); };
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 2000;
    this.controls.addEventListener("start", this.onControlsStart);
    this.controls.addEventListener("end", this.onControlsEnd);
    this.controls.addEventListener("change", this.onControlsChange);
    this.resizeObserver = new ResizeObserver(() => this.resize(container));
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize(container);
  }

  async init(): Promise<void> {
    try {
      await this.renderer.init();
      if (this.disposed) return;
      this.canvas.dataset.rendererBackend = (this.renderer.backend as typeof this.renderer.backend & { isWebGPUBackend?: boolean }).isWebGPUBackend ? "webgpu" : "webgl2";
      this.ready = true;
      this.wake();
    } catch (reason) {
      if (!this.disposed) this.fail(reason);
    }
  }

  setSource(source: SceneSource): void {
    if (source.seekGeneration !== this.lastSeekGeneration) {
      this.lastSeekGeneration = source.seekGeneration;
      this.lastDrawAt = 0;
      this.smoothYaw = Number.NaN;
    }
    if (this.source?.playing !== source.playing || this.source?.recording !== source.recording || this.source?.seekGeneration !== source.seekGeneration) this.labelGeneration++;
    this.source = source;
    this.wake();
  }

  updateConfig(config: SceneRuntimeConfig): void {
    const previous = this.config;
    this.config = config;
    if (previous?.viewPreset !== config.viewPreset || previous?.autoOrbit !== config.autoOrbit) {
      if (!config.autoOrbit) {
        const preset = VIEW_PRESETS[config.viewPreset];
        this.camera.position.set(...preset.position);
        this.controls.target.set(...preset.target);
        this.controls.update();
      }
    }
    this.controls.enabled = !config.autoOrbit;
    const key = `${config.carModel.modelPath}:${config.toggles.solid}:${config.modelOffsetX}:${config.hideModelWheels}`;
    if (key !== this.modelKey) {
      this.modelKey = key;
      void this.loadBody(config);
    }
    this.labelGeneration++;
    try {
      this.overlays ??= new SceneOverlays(this.scene, this.camera);
    } catch (reason) {
      this.fail(reason);
      return;
    }
    this.wake();
  }

  requestFrame(generation = this.source?.seekGeneration ?? 0): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Scene runtime disposed"));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ generation, resolve, reject });
      this.wake();
    });
  }
  /** Native WebGPU canvas bitmaps can be empty after present; read a separate render target. */
  async captureBitmap(): Promise<ImageBitmap> {
    if (this.disposed) throw new Error("Scene runtime disposed");
    if (!this.ready) await this.requestFrame();
    const width = this.canvas.width;
    const height = this.canvas.height;
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

  private resize(container: HTMLElement): void {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height || this.disposed) return;
    this.renderer.setPixelRatio(Math.min(1.5, Math.max(1, window.devicePixelRatio)));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.wake();
  }

  private wake(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.ready && !this.drawing && !this.raf && !document.hidden) this.raf = requestAnimationFrame(this.draw);
  }

  private stop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly draw = (now: number): void => {
    this.raf = 0;
    if (!this.ready || this.disposed || document.hidden) return;
    const source = this.source;
    const config = this.config;
    const active = !!source?.playing || this.cameraMoving;
    if (!this.dirty && !active) return;
    const cap = Math.max(15, Math.min(120, config?.fpsCap ?? 60));
    if (!source?.recording && now + 1 < this.nextDrawAt) {
      this.raf = requestAnimationFrame(this.draw);
      return;
    }
    const interval = 1000 / cap;
    this.nextDrawAt = now + interval;
    this.dirty = false;
    const frames = source?.framesRef.current ?? config?.telemetry ?? [];
    const cursorIdx = source?.cursorRef.current ?? config?.cursorIdx ?? 0;
    const frame = frames[cursorIdx] ?? config?.frame;
    this.drawing = true;
    try {
      if (frame && config) this.updatePose(frame, frames, cursorIdx, now, this.lastDrawAt ? (now - this.lastDrawAt) / 1000 : 0);
      if (this.controls.enabled && this.controls.enableDamping) this.controls.update();
      this.renderer.info.reset();
      this.renderer.render(this.scene, this.camera);
    } catch (reason) {
      this.drawing = false;
      this.fail(reason);
      return;
    }
    this.drawing = false;
    this.lastDrawAt = now;
    this.fpsFrames++;
    if (now - this.fpsStart >= 1000) {
      if (this.fpsElement && this.fpsStart) this.fpsElement.textContent = `${Math.round(this.fpsFrames * 1000 / (now - this.fpsStart))} fps`;
      this.fpsFrames = 0;
      this.fpsStart = now;
    }
    if (now - this.lastGpuLog >= 1000) {
      this.lastGpuLog = now;
      recordGpuSnapshot({
        memory: this.renderer.info.memory,
        programs: { length: this.renderer.info.memory.programs },
        render: { calls: this.renderer.info.render.drawCalls, triangles: this.renderer.info.render.triangles },
      });
    }
    if (!this.loadingModel) {
      const generation = source?.seekGeneration ?? 0;
      const ready = this.pending.filter((item) => item.generation <= generation);
      this.pending = this.pending.filter((item) => item.generation > generation);
      for (const item of ready) item.resolve();
    }
    if (active || this.dirty || this.pending.length) this.raf = requestAnimationFrame(this.draw);
  };

  private async loadBody(config: SceneRuntimeConfig): Promise<void> {
    const generation = ++this.modelGeneration;
    this.body?.dispose();
    this.body = null;
    this.loadingModel = config.carModel.hasModel;
    if (!config.carModel.hasModel) {
      this.loadingModel = false;
      this.wake();
      return;
    }
    try {
      const body = await createCarBody(config.carModel, config.toggles.solid, config.modelOffsetX, config.hideModelWheels);
      if (generation !== this.modelGeneration || this.disposed) {
        body.dispose();
        return;
      }
      this.bodyMotion.add(body.root);
      this.body = body;
      this.loadingModel = false;
      this.wake();
    } catch (reason) {
      if (generation === this.modelGeneration && !this.disposed) this.fail(reason);
    }
  }


  private updatePose(frame: SemanticAnalysisFrame, frames: SemanticAnalysisFrame[], cursorIdx: number, now: number, elapsed: number): void {
    const config = this.config;
    if (!config) return;
    const normalized = frame.values["suspension.norm-suspension-travel"];
    const range = config.gameId === "acc" ? { min: 0, max: 50 } : config.gameId === "iracing" ? { min: 0, max: 100 } : undefined;
    const suspension = Array.isArray(normalized) && normalized.length >= 4 &&
      Number.isFinite(normalized[0]) && Number.isFinite(normalized[1]) &&
      Number.isFinite(normalized[2]) && Number.isFinite(normalized[3])
      ? normalized : normalizeSuspensionTravel(frame.values["suspension.suspension-travel-m"] as unknown[], range);
    const fl = Number(suspension[0]) || 0, fr = Number(suspension[1]) || 0;
    const rl = Number(suspension[2]) || 0, rr = Number(suspension[3]) || 0;
    const stroke = config.carModel.suspStroke ?? 0.08;
    this.bodyMotion.position.set(-0.065, -((fl + fr + rl + rr) / 4 - 0.5) * stroke, 0);
    this.bodyMotion.rotation.set(((fr + rr - fl - rl) / 2) * 0.1, 0, ((fl + fr - rl - rr) / 2) * 0.06);
    if (config.autoOrbit) {
      const yaw = semanticNumber(frame, "motion.yaw") ?? 0;
      if (!Number.isFinite(this.smoothYaw) || !this.source?.playing) this.smoothYaw = yaw;
      else {
        let difference = yaw - this.smoothYaw;
        while (difference > Math.PI) difference -= 2 * Math.PI;
        while (difference < -Math.PI) difference += 2 * Math.PI;
        this.smoothYaw += difference * (1 - Math.exp(-2.45 * elapsed));
      }
      this.camera.position.set(Math.sin(this.smoothYaw) * 5, 1.8, Math.cos(this.smoothYaw) * 5);
      this.camera.lookAt(0, 0.3, 0);
    }
    this.overlays?.update(frame, frames, cursorIdx, config, this.source, now, elapsed, this.labelGeneration, this.canvas.clientHeight);
  }

  private fail(reason: unknown): void {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    this.ready = false;
    this.stop();
    for (const item of this.pending) item.reject(error);
    this.pending = [];
    this.onError(error);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.modelGeneration++;
    this.canvas.removeEventListener("dblclick", this.onModelDoubleClick);
    this.body?.dispose();
    this.overlays?.dispose();
    this.overlays = null;
    this.stop();
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.controls.removeEventListener("start", this.onControlsStart);
    this.controls.removeEventListener("end", this.onControlsEnd);
    this.controls.removeEventListener("change", this.onControlsChange);
    this.controls.dispose();
    for (const item of this.pending) item.reject(new Error("Scene runtime disposed"));
    this.pending = [];
    this.captureTarget?.dispose();
    this.captureTarget = null;
    this.captureCanvas = null;
    this.captureImageData = null;
    this.renderer.dispose();
    this.canvas.remove();
  }
}
