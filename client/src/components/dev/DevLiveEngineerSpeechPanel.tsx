import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";

const relations = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"] as const;
const spotterStates = ["clear", "car-left", "still-there", "three-wide-left", "clear-left", "car-right", "three-wide-right", "clear-right"] as const;
type Clip = { segmentId: string; spokenText: string; path: string; durationMs: number; sha256: string };
type Catalog = { catalogVersion: string; pipelineVersion: string | null; validation: boolean; clipCount: number; lines: Clip[] };
const flow = [
  { id: "clear", label: "Clear", detail: "No overlap", priority: "idle" },
  { id: "car-left", label: "Car left", detail: "New overlap", priority: "high" },
  { id: "car-right", label: "Car right", detail: "New overlap", priority: "high" },
  { id: "still-there", label: "Still there", detail: "3s repeat", priority: "normal" },
  { id: "three-wide-left", label: "Three wide left", detail: "2+ left", priority: "high" },
  { id: "three-wide-right", label: "Three wide right", detail: "2+ right", priority: "high" },
  { id: "clear-left", label: "Clear left", detail: "500ms gap", priority: "normal" },
  { id: "clear-right", label: "Clear right", detail: "500ms gap", priority: "normal" },
] as const;

export function DevLiveEngineerSpeechPanel() {
  const [relation, setRelation] = useState<(typeof relations)[number]>("within-class-pace");
  const [voiceMode, setVoiceMode] = useState<"automatic" | "exact-response">("automatic");
  const [spotterState, setSpotterState] = useState<(typeof spotterStates)[number]>("clear");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const activeAudio = useRef<HTMLAudioElement[]>([]);
  const loadCatalog = async () => setCatalog(await (await fetch("/api/dev/live-engineer/catalog")).json() as Catalog);
  useEffect(() => { void loadCatalog(); return () => activeAudio.current.forEach((audio) => audio.pause()); }, []);
  const stop = () => { activeAudio.current.forEach((audio) => audio.pause()); activeAudio.current = []; setPlaying(null); };
  const playSegments = (id: string, segmentIds: string[]): Promise<void> => {
    stop();
    const clips = segmentIds.map((segmentId) => catalog?.lines.find((clip) => clip.segmentId === segmentId)).filter((clip): clip is Clip => !!clip);
    if (clips.length !== segmentIds.length) { setResult({ error: "Missing audio catalog segments", missing: segmentIds.filter((segmentId) => !clips.some((clip) => clip.segmentId === segmentId)) }); return Promise.resolve(); }
    setPlaying(id);
    return (async () => {
      try { for (const clip of clips) { const audio = new Audio(`/audio/live-engineer/v1/${clip.path}`); activeAudio.current.push(audio); await new Promise<void>((resolve, reject) => { audio.onended = () => resolve(); audio.onerror = () => reject(new Error(`Unable to load ${clip.segmentId}`)); audio.play().catch(reject); }); } }
      catch (error) { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); }
      finally { activeAudio.current = []; setPlaying(null); }
    })();
  };
  const previewSpotter = async (state: (typeof spotterStates)[number]) => {
    const response = await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state, overlapCount: state.includes("three-wide") ? 2 : 1 }) });
    setResult(await response.json() as Record<string, unknown>);
  };
  const simulateSpotter = async () => { const playback = spotterState === "clear" ? Promise.resolve() : playSegments(`spotter-${spotterState}`, [`spotter.${spotterState}`]); await previewSpotter(spotterState); await playback; };
  const simulateFlow = async (states: readonly (typeof spotterStates[number])[]) => { for (const state of states) { setSpotterState(state); const playback = state === "clear" ? Promise.resolve() : playSegments(`spotter-flow-${state}`, [`spotter.${state}`]); await previewSpotter(state); await playback; await new Promise((resolve) => setTimeout(resolve, 150)); } };
  const previewPace = async () => { const response = await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relation, scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_300, benchmarkLapTimeMs: 60_000, deltaMs: 300, benchmarkKind: "session-best", voiceMode }) }); const rendered = await response.json() as { segmentIds?: string[]; [key: string]: unknown }; setResult(rendered); if (rendered.segmentIds) await playSegments("pace", rendered.segmentIds); };
  return <div className="h-full overflow-y-auto p-6">
    <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Live Engineer Speech</h2><p className="text-sm text-app-text-muted">Deterministic voice atoms and CrewChief-style spotter simulation.</p></div><Button onClick={() => void loadCatalog()}>Refresh catalog</Button></div>
    <div className="mt-4 flex flex-wrap gap-2"><select aria-label="Relation" value={relation} onChange={(e) => setRelation(e.target.value as (typeof relations)[number])}>{relations.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Voice mode" value={voiceMode} onChange={(e) => setVoiceMode(e.target.value as "automatic" | "exact-response") }><option value="automatic">Automatic</option><option value="exact-response">Exact pace</option></select><Button onClick={() => void previewPace()}>Preview pace</Button><Button onClick={stop}>Stop</Button></div>
    <section className="mt-6 rounded border border-app-border p-4"><div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]"><div><h3 className="font-semibold">Spotter state machine</h3><p className="mt-1 text-xs text-app-text-muted">Choose state or run full left/right flow. Priority matches runtime arbitration.</p><div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">{spotterStates.map((state) => <button key={state} type="button" onClick={() => setSpotterState(state)} className={`rounded border px-2 py-3 ${spotterState === state ? "border-app-accent bg-app-accent/15 text-app-accent" : "border-app-border bg-app-surface-alt"}`} aria-pressed={spotterState === state}><span className="block font-semibold">{state}</span><span className="mt-1 block text-[10px] text-app-text-muted">{state.includes("three") ? "2 overlaps · high" : state === "clear" ? "idle" : state === "still-there" ? "1 overlap · normal" : "1 overlap · high"}</span></button>)}</div><div className="mt-4 flex flex-wrap items-center gap-3"><select aria-label="Spotter state" value={spotterState} onChange={(e) => setSpotterState(e.target.value as (typeof spotterStates)[number])}>{spotterStates.map((state) => <option key={state}>{state}</option>)}</select><Button onClick={() => void simulateSpotter()} disabled={playing !== null || catalog === null}>Simulate state and speak</Button><Button variant="outline" onClick={() => void simulateFlow(["car-left", "still-there", "three-wide-left", "clear-left"])} disabled={playing !== null || catalog === null}>Run left flow</Button><Button variant="outline" onClick={() => void simulateFlow(["car-right", "still-there", "three-wide-right", "clear-right"])} disabled={playing !== null || catalog === null}>Run right flow</Button><Button onClick={stop}>Stop</Button></div></div><aside aria-label="Spotter state flow graph" className="rounded border border-app-border bg-app-surface-alt p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">Flow + priority</h4><div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">{flow.map((node) => <button key={node.id} type="button" onClick={() => setSpotterState(node.id as (typeof spotterStates)[number])} className={`rounded border px-2 py-2 text-left ${spotterState === node.id ? "border-app-accent bg-app-accent/15" : "border-app-border"}`}><div className="font-semibold">{node.label}</div><div className="text-app-text-muted">{node.detail}</div><div className="mt-1 uppercase tracking-wide text-app-text-muted">{node.priority}</div></button>)}</div><div className="mt-3 text-[10px] text-app-text-muted">Entry → hold → escalation → clear. Higher priority wins when states compete.</div></aside></div></section>
    {result && <pre className="mt-4 whitespace-pre-wrap rounded border border-app-border p-4 text-xs">{JSON.stringify(result, null, 2)}</pre>}
    {catalog && <p className="mt-3 text-xs text-app-text-muted">{catalog.clipCount} clips · {catalog.pipelineVersion ?? "no generated catalog"} · validation {catalog.validation ? "passed" : "pending"}</p>}
    <div className="mt-6 overflow-hidden rounded border border-app-border"><div className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] gap-3 border-b border-app-border bg-app-surface-alt px-3 py-2 text-xs font-semibold"><span>Line</span><span>Audio</span><span>Status</span></div>{catalog?.lines.map((clip) => <div key={clip.segmentId} className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] items-center gap-3 border-b border-app-border px-3 py-3 text-xs"><div><div className="font-medium">{clip.segmentId}</div><div className="text-app-text-muted">{clip.spokenText}</div></div><audio controls preload="none" src={`/audio/live-engineer/v1/${clip.path}`} className="h-8 w-full" /><div className="text-app-text-muted">{clip.durationMs} ms</div></div>)}</div>
  </div>;
}
