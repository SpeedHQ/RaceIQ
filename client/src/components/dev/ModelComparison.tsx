import { OrbitControls, useGLTF } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
import * as THREE from "three";
import { THREE_COLORS } from "../../lib/wireframe-utils";

type ModelId = "gt3" | "f1";
type AssetChoice = "original" | "optimized";
interface ModelStats { sizeBytes: number; vertexCount: number }
interface StatsPayload { original: ModelStats; optimized: ModelStats }
const MODEL_LABELS: Record<ModelId, string> = { gt3: "Aston Martin GT3", f1: "McLaren MCL39 F1" };
const MODEL_URLS: Record<ModelId, Record<AssetChoice, string>> = {
  gt3: { original: "/api/dev/models/gt3/original", optimized: "/models/aston_martin_vantage_gt3_optimised.glb" },
  f1: { original: "/api/dev/models/f1/original", optimized: "/models/f1_2025_mclaren_mcl39_optimised.glb" },
};
function formatBytes(bytes: number): string { return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`; }
function ComparisonModel({ modelId, asset, wireframe }: { modelId: ModelId; asset: AssetChoice; wireframe: boolean }) {
  const { scene } = useGLTF(MODEL_URLS[modelId][asset]);
  const model = useMemo(() => { const clone = scene.clone(true); clone.traverse((object) => { if (!(object instanceof THREE.Mesh)) return; object.material = new THREE.MeshStandardMaterial({ color: asset === "optimized" ? THREE_COLORS.appAccent : THREE_COLORS.dimensionSecondary, metalness: 0.25, roughness: 0.62, wireframe }); }); return clone; }, [asset, scene, wireframe]);
  return <primitive object={model} scale={1.05} />;
}
export function ModelComparison() {
  const [modelId, setModelId] = useState<ModelId>("gt3");
  const [asset, setAsset] = useState<AssetChoice>("optimized");
  const [wireframe, setWireframe] = useState(true);
  const [stats, setStats] = useState<StatsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelUrls = MODEL_URLS[modelId];
  const currentStats = stats?.[asset];
  useEffect(() => { let active = true; setStats(null); setError(null); fetch(`/api/dev/models/${modelId}`).then((response) => { if (!response.ok) throw new Error(`Stats request failed (${response.status})`); return response.json() as Promise<StatsPayload>; }).then((payload) => { if (active) setStats(payload); }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load model stats"); }); return () => { active = false; }; }, [modelId]);
  const sizeReduction = stats ? ((1 - stats.optimized.sizeBytes / stats.original.sizeBytes) * 100).toFixed(2) : "—";
  const vertexReduction = stats ? ((1 - stats.optimized.vertexCount / stats.original.vertexCount) * 100).toFixed(2) : "—";
  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-app-surface">
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-app-border bg-app-surface-alt px-5 py-4"><div><p className="text-xs font-semibold uppercase tracking-wide text-app-accent">Model lab</p><h2 className="mt-1 text-lg font-semibold text-app-text">{MODEL_LABELS[modelId]} comparison</h2><p className="mt-1 text-xs text-app-text-muted">Dev-only original route. Optimized derivative is shipped asset.</p></div><div className="flex flex-wrap gap-2 text-sm">{(Object.keys(MODEL_LABELS) as ModelId[]).map((choice) => <button key={choice} type="button" onClick={() => setModelId(choice)} className={`rounded border px-3 py-2 transition-colors ${modelId === choice ? "border-app-accent bg-app-accent text-app-on-filled" : "border-app-border text-app-text-muted hover:text-app-text"}`}>{choice === "gt3" ? "GT3" : "F1"}</button>)}{(Object.keys(modelUrls) as AssetChoice[]).map((choice) => <button key={choice} type="button" onClick={() => setAsset(choice)} className={`rounded border px-3 py-2 capitalize transition-colors ${asset === choice ? "border-app-accent bg-app-accent text-app-on-filled" : "border-app-border text-app-text-muted hover:text-app-text"}`}>{choice}</button>)}<button type="button" onClick={() => setWireframe((value) => !value)} className={`rounded border px-3 py-2 transition-colors ${wireframe ? "border-app-accent bg-app-accent text-app-on-filled" : "border-app-border text-app-text-muted hover:text-app-text"}`}>{wireframe ? "Wireframe" : "Solid"}</button></div></div>
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-px bg-app-border lg:grid-cols-[minmax(0,1fr)_280px]"><div className="relative min-h-[420px] bg-app-bg"><Canvas camera={{ position: [4.8, 2.4, 4.8], fov: 38 }} dpr={[1, 1.5]}><color attach="background" args={[THREE_COLORS.appSurfaceAlt]} /><ambientLight intensity={1.4} /><directionalLight position={[5, 8, 5]} intensity={3} /><directionalLight position={[-4, 2, -3]} intensity={1.2} color={THREE_COLORS.dimensionSecondary} /><ComparisonModel modelId={modelId} asset={asset} wireframe={wireframe} /><OrbitControls makeDefault enableDamping dampingFactor={0.08} /></Canvas><div className="pointer-events-none absolute left-4 top-4 rounded bg-app-bg/80 px-3 py-2 font-mono text-xs text-app-text">{modelId} / {asset} / {wireframe ? "wireframe" : "solid"}</div></div><aside className="overflow-y-auto bg-app-surface p-5"><div className="mb-5"><p className="text-xs uppercase tracking-wide text-app-text-muted">Loaded asset</p><p className="mt-1 break-all font-mono text-xs text-app-text">{modelUrls[asset]}</p></div>{error ? <p className="rounded border border-status-danger/40 bg-status-danger/10 p-3 text-sm text-status-danger">{error}</p> : null}<div className="grid gap-3"><Stat label="File size" value={currentStats ? formatBytes(currentStats.sizeBytes) : "Loading…"} /><Stat label="Vertices" value={currentStats ? currentStats.vertexCount.toLocaleString() : "Loading…"} /><Stat label="Size reduction" value={`${sizeReduction}%`} /><Stat label="Vertex reduction" value={`${vertexReduction}%`} /></div>{stats ? <div className="mt-6 border-t border-app-border pt-5 text-xs text-app-text-muted"><div className="flex justify-between"><span>Original</span><span className="font-mono">{formatBytes(stats.original.sizeBytes)} / {stats.original.vertexCount.toLocaleString()}</span></div><div className="mt-2 flex justify-between"><span>Optimized</span><span className="font-mono">{formatBytes(stats.optimized.sizeBytes)} / {stats.optimized.vertexCount.toLocaleString()}</span></div></div> : null}</aside></div>
  </div>;
}
function Stat({ label, value }: { label: string; value: string }) { return <div className="rounded border border-app-border bg-app-surface-alt p-3"><p className="text-xs text-app-text-muted">{label}</p><p className="mt-1 font-mono text-lg font-semibold text-app-text">{value}</p></div>; }
useGLTF.preload(MODEL_URLS.gt3.optimized);
useGLTF.preload(MODEL_URLS.f1.optimized);
