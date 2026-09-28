import type { CarModelEnrichment } from "../../data/car-models";
import * as THREE from "three";
import { useEffect, useRef, useState } from "react";
import { Switch } from "../ui/switch";
import { createCarBody, type CarBodyInstance } from "../wireframe/CarBody";
import { SceneRuntime } from "../wireframe/SceneRuntime";
import { THREE_COLORS } from "../../lib/wireframe-utils";
import { DEMO_CAR, F1_CAR, LMU_HYPERCAR_CAR } from "../../data/car-models";

type ModelId = "gt3" | "f1" | "peugeot";
type AssetChoice = "original" | "optimized";
interface ModelStats {
  sizeBytes: number;
  vertexCount: number;
}
interface StatsPayload {
  original: ModelStats;
  optimized: ModelStats;
}
interface ModelDefinition {
  label: string;
  urls: Record<AssetChoice, string>;
  carModel: CarModelEnrichment & { hasModel: true };
}
const MODEL_DEFINITIONS: Record<ModelId, ModelDefinition> = {
  gt3: {
    label: "Aston Martin GT3",
    urls: { original: "/api/dev/models/gt3/original", optimized: DEMO_CAR.modelPath },
    carModel: DEMO_CAR,
  },
  f1: {
    label: "McLaren MCL39 F1",
    urls: { original: "/api/dev/models/f1/original", optimized: F1_CAR.modelPath },
    carModel: F1_CAR,
  },
  peugeot: {
    label: "Peugeot 9X8 Evo Hypercar",
    urls: { original: "/api/dev/models/peugeot/original", optimized: LMU_HYPERCAR_CAR.modelPath },
    carModel: LMU_HYPERCAR_CAR,
  },
};
const MODEL_LABELS = Object.fromEntries(Object.entries(MODEL_DEFINITIONS).map(([id, definition]) => [id, definition.label])) as Record<ModelId, string>;
const MODEL_URLS = Object.fromEntries(Object.entries(MODEL_DEFINITIONS).map(([id, definition]) => [id, definition.urls])) as Record<ModelId, Record<AssetChoice, string>>;

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
export function ModelComparison() {
  const [modelId, setModelId] = useState<ModelId>("gt3");
  const [asset, setAsset] = useState<AssetChoice>("optimized");
  const [wireframe, setWireframe] = useState(true);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const bodyRef = useRef<CarBodyInstance | null>(null);
  const generationRef = useRef(0);
  const modelUrls = MODEL_URLS[modelId];
  const currentStats = stats?.[asset];

  useEffect(() => {
    const container = viewportRef.current;
    if (!container) return;
    let active = true;
    const runtime = new SceneRuntime(container, (reason) => {
      if (active) setError(reason.message);
    }, {
      cameraPosition: [4.8, 2.4, 4.8],
      fov: 38,
      background: THREE_COLORS.appSurfaceAlt,
    });
    runtime.controls.enableDamping = true;
    runtime.controls.dampingFactor = 0.08;
    runtime.controls.enablePan = true;
    runtime.scene.remove(...runtime.scene.children.filter((node) => node instanceof THREE.Light));
    runtime.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3);
    keyLight.position.set(5, 8, 5);
    runtime.scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(THREE_COLORS.dimensionSecondary, 1.2);
    fillLight.position.set(-4, 2, -3);
    runtime.scene.add(fillLight);
    runtimeRef.current = runtime;
    void runtime.init().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to initialize 3D renderer");
    });
    return () => {
      active = false;
      generationRef.current++;
      bodyRef.current?.dispose();
      bodyRef.current = null;
      runtimeRef.current = null;
      runtime.dispose();
    };
  }, []);

  useEffect(() => {
    let active = true;
    setStats(null);
    setError(null);
    fetch(`/api/dev/models/${modelId}`)
      .then((response) => {
        if (!response.ok) throw new Error(`Stats request failed (${response.status})`);
        return response.json() as Promise<StatsPayload>;
      })
      .then((payload) => {
        if (active) setStats(payload);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : "Unable to load model stats");
      });
    return () => {
      active = false;
    };
  }, [modelId]);

  useEffect(() => {
    const generation = ++generationRef.current;
    bodyRef.current?.dispose();
    bodyRef.current = null;
    const definition = MODEL_DEFINITIONS[modelId];
    const carModel = { ...definition.carModel, modelPath: definition.urls[asset] };
    void createCarBody(carModel, wireframe ? "wire" : "solid", 0).then((body) => {
      if (generation !== generationRef.current || !runtimeRef.current) {
        body.dispose();
        return;
      }
      bodyRef.current = body;
      runtimeRef.current.scene.add(body.root);
      void runtimeRef.current.requestFrame().catch((reason: unknown) => {
        if (generation === generationRef.current) setError(reason instanceof Error ? reason.message : "Unable to render model");
      });
    }).catch((reason: unknown) => {
      if (generation === generationRef.current) setError(reason instanceof Error ? reason.message : "Unable to load model");
    });
  }, [modelId, asset, wireframe]);
  const sizeReduction = stats ? ((1 - stats.optimized.sizeBytes / stats.original.sizeBytes) * 100).toFixed(2) : "—";
  const vertexReduction = stats ? ((1 - stats.optimized.vertexCount / stats.original.vertexCount) * 100).toFixed(2) : "—";
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-surface">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border bg-app-surface-alt px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-app-accent">Model lab</p>
          <h2 className="mt-1 text-lg font-semibold text-app-text">{MODEL_LABELS[modelId]} comparison</h2>
          <p className="mt-1 text-xs text-app-text-muted">Dev-only original route. Optimized derivative is shipped asset.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {(Object.keys(MODEL_LABELS) as ModelId[]).map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setModelId(choice)}
              className={`rounded border px-3 py-2 transition-colors ${modelId === choice ? "border-app-accent bg-app-accent text-app-on-filled" : "border-app-border text-app-text-muted hover:text-app-text"}`}
            >
              {choice === "gt3" ? "GT3" : choice === "f1" ? "F1" : "Peugeot"}
            </button>
          ))}
          {(Object.keys(modelUrls) as AssetChoice[]).map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => setAsset(choice)}
              className={`rounded border px-3 py-2 capitalize transition-colors ${asset === choice ? "border-app-accent bg-app-accent text-app-on-filled" : "border-app-border text-app-text-muted hover:text-app-text"}`}
            >
              {choice}
            </button>
          ))}
          <div className="flex items-center gap-2 rounded border border-app-border px-3 py-2 text-sm text-app-text-muted">
            <Switch size="sm" checked={wireframe} aria-label="Wireframe" onCheckedChange={setWireframe} />
            <span>{wireframe ? "Wireframe" : "Solid"}</span>
          </div>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-app-border lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="relative min-h-[420px] bg-app-bg">
          <div ref={viewportRef} className="absolute inset-0" />
          <div className="pointer-events-none absolute left-4 top-4 rounded bg-app-bg/80 px-3 py-2 font-mono text-xs text-app-text">
            {modelId} / {asset} / {wireframe ? "wireframe" : "solid"}
          </div>
          {error ? <div role="alert" className="absolute bottom-4 left-4 right-4 rounded border border-status-danger/40 bg-app-bg/95 p-3 text-sm text-status-danger">{error}</div> : null}
        </div>
        <aside className="overflow-y-auto bg-app-surface p-5">
          <div className="mb-5">
            <p className="text-xs uppercase tracking-wide text-app-text-muted">Loaded asset</p>
            <p className="mt-1 break-all font-mono text-xs text-app-text">{modelUrls[asset]}</p>
          </div>
          {error ? <p className="rounded border border-status-danger/40 bg-status-danger/10 p-3 text-sm text-status-danger">{error}</p> : null}
          <div className="grid gap-3">
            <Stat label="File size" value={currentStats ? formatBytes(currentStats.sizeBytes) : "Loading…"} />
            <Stat label="Vertices" value={currentStats ? currentStats.vertexCount.toLocaleString() : "Loading…"} />
            <Stat label="Size reduction" value={`${sizeReduction}%`} />
            <Stat label="Vertex reduction" value={`${vertexReduction}%`} />
          </div>
          {stats ? (
            <div className="mt-6 border-t border-app-border pt-5 text-xs text-app-text-muted">
              <div className="flex justify-between">
                <span>Original</span>
                <span className="font-mono">{formatBytes(stats.original.sizeBytes)} / {stats.original.vertexCount.toLocaleString()}</span>
              </div>
              <div className="mt-2 flex justify-between">
                <span>Optimized</span>
                <span className="font-mono">{formatBytes(stats.optimized.sizeBytes)} / {stats.optimized.vertexCount.toLocaleString()}</span>
              </div>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-app-border bg-app-surface-alt p-3">
      <p className="text-xs text-app-text-muted">{label}</p>
      <p className="mt-1 font-mono text-lg font-semibold text-app-text">{value}</p>
    </div>
  );
}
