import { useState } from "react";
import { Button } from "../ui/button";
import { useDevSpeechAudio } from "./DevSpeechAudio";

const states = ["clear", "car-left", "still-there", "three-wide-left", "clear-left", "car-right", "three-wide-right", "clear-right"] as const;
const flow = [
  ["clear", "Clear", "No overlap", "idle"], ["car-left", "Car left", "New overlap", "high"], ["car-right", "Car right", "New overlap", "high"], ["still-there", "Still there", "3s repeat", "normal"],
  ["three-wide-left", "Three wide left", "2+ left", "high"], ["three-wide-right", "Three wide right", "2+ right", "high"], ["clear-left", "Clear left", "500ms gap", "normal"], ["clear-right", "Clear right", "500ms gap", "normal"],
] as const;

export function DevSpotterSpeechPanel() {
  const [state, setState] = useState<(typeof states)[number]>("clear");
  const audio = useDevSpeechAudio(true);
  const preview = async (nextState: (typeof states)[number]) => {
    const response = await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: nextState, overlapCount: nextState.includes("three-wide") ? 2 : 1 }) });
    audio.setResult(await response.json() as Record<string, unknown>);
  };
  const simulate = async () => {
    const playback = state === "clear" ? Promise.resolve() : audio.playSegments(`spotter-${state}`, [`spotter.${state}`]);
    await preview(state);
    await playback;
  };
  const runFlow = async (sequence: readonly (typeof states[number])[]) => {
    for (const nextState of sequence) {
      setState(nextState);
      const playback = nextState === "clear" ? Promise.resolve() : audio.playSegments(`spotter-flow-${nextState}`, [`spotter.${nextState}`]);
      await preview(nextState);
      await playback;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  };
  return <div className="h-full overflow-y-auto p-6"><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Spotter Speech</h2><p className="text-sm text-app-text-muted">CrewChief-style spotter state transitions and audio.</p></div><Button onClick={() => void audio.loadCatalog()}>Refresh catalog</Button></div><section className="mt-6 rounded border border-app-border p-4"><div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem]"><div><h3 className="font-semibold">Spotter state machine</h3><p className="mt-1 text-xs text-app-text-muted">Choose state or run full left/right flow. Priority matches runtime arbitration.</p><div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs">{states.map((item) => <button key={item} type="button" onClick={() => setState(item)} className={`rounded border px-2 py-3 ${state === item ? "border-app-accent bg-app-accent/15 text-app-accent" : "border-app-border bg-app-surface-alt"}`} aria-pressed={state === item}><span className="block font-semibold">{item}</span><span className="mt-1 block text-[10px] text-app-text-muted">{item.includes("three") ? "2 overlaps · high" : item === "clear" ? "idle" : item === "still-there" ? "1 overlap · normal" : "1 overlap · high"}</span></button>)}</div><div className="mt-4 flex flex-wrap items-center gap-3"><select aria-label="Spotter state" value={state} onChange={(event) => setState(event.target.value as (typeof states)[number])}>{states.map((item) => <option key={item}>{item}</option>)}</select><Button onClick={() => void simulate()} disabled={audio.playing !== null || audio.catalog === null}>Simulate state and speak</Button><Button variant="outline" onClick={() => void runFlow(["car-left", "still-there", "three-wide-left", "clear-left"])} disabled={audio.playing !== null || audio.catalog === null}>Run left flow</Button><Button variant="outline" onClick={() => void runFlow(["car-right", "still-there", "three-wide-right", "clear-right"])} disabled={audio.playing !== null || audio.catalog === null}>Run right flow</Button><Button onClick={audio.stop}>Stop</Button></div></div><aside aria-label="Spotter state flow graph" className="rounded border border-app-border bg-app-surface-alt p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">Flow + priority</h4><div className="mt-3 grid grid-cols-2 gap-2 text-[10px]">{flow.map(([id, label, detail, priority]) => <button key={id} type="button" onClick={() => setState(id as (typeof states)[number])} className={`rounded border px-2 py-2 text-left ${state === id ? "border-app-accent bg-app-accent/15" : "border-app-border"}`}><div className="font-semibold">{label}</div><div className="text-app-text-muted">{detail}</div><div className="mt-1 uppercase tracking-wide text-app-text-muted">{priority}</div></button>)}</div><div className="mt-3 text-[10px] text-app-text-muted">Entry → hold → escalation → clear.</div></aside></div></section>{audio.result && <pre className="mt-4 whitespace-pre-wrap rounded border border-app-border p-4 text-xs">{JSON.stringify(audio.result, null, 2)}</pre>}<SpeechCatalog audio={audio} /></div>;
}

function SpeechCatalog({ audio }: { audio: ReturnType<typeof useDevSpeechAudio> }) { return <><p className="mt-3 text-xs text-app-text-muted">{audio.catalog ? `${audio.visibleLines.length} Qwen clips · ${audio.catalog.model ?? "Qwen"} · validation ${audio.catalog.validation ? "passed" : "pending"}` : "Loading Qwen audio catalog…"}</p><div className="mt-6 overflow-hidden rounded border border-app-border"><div className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] gap-3 border-b border-app-border bg-app-surface-alt px-4 py-2 text-xs font-semibold text-app-text-muted"><span>State</span><span>Clip</span><span /></div>{audio.visibleLines.map((clip) => <div key={clip.segmentId} className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] items-center gap-3 border-b border-app-border px-4 py-3 text-sm"><span>{clip.segmentId.replace("spotter.", "")}</span><span className="truncate">{clip.spokenText}</span><Button variant="app-outline" size="icon-sm" aria-label={`Play Qwen clip: ${clip.spokenText}`} onClick={() => void audio.playQwenClip(`qwen-spotter-${clip.segmentId}`, clip.segmentId)}>Q</Button></div>)}</div></> }
