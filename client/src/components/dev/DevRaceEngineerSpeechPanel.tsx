import { useMemo, useState } from "react";
import { Button } from "../ui/button";
import { useDevSpeechAudio, type SpeechClip } from "./DevSpeechAudio";
import { formatLiveEngineerDeltaText } from "../../../../shared/racing/live/time-text";

const relations = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"] as const;
const sentenceExamples = [
  { kind: "pace", id: "fastest-class", relation: "fastest-in-class", scope: "class", label: "Fastest in class." },
  { kind: "pace", id: "fastest-overall", relation: "fastest-in-class", scope: "overall", label: "Fastest overall." },
  { kind: "pace", id: "setting-race-pace", relation: "setting-race-pace", scope: "class", label: "You are setting the current race pace." },
  { kind: "pace", id: "within-class-pace", relation: "within-class-pace", scope: "class", label: "You are point three seconds from class pace." },
  { kind: "pace", id: "within-overall-pace", relation: "within-class-pace", scope: "overall", label: "You are point three seconds from overall pace." },
  { kind: "pace", id: "off-class-pace", relation: "off-class-pace", scope: "class", label: "You are point three seconds off class pace." },
  { kind: "pace", id: "off-overall-pace", relation: "off-class-pace", scope: "overall", label: "You are point three seconds off overall pace." },
  { kind: "pace", id: "outlier-class", relation: "outlier-lap", scope: "class", label: "That lap is point three seconds off class pace." },
  { kind: "pace", id: "outlier-overall", relation: "outlier-lap", scope: "overall", label: "That lap is point three seconds off overall pace." },
  { kind: "lap-time", id: "lap-time", label: "Your lap was one minute thirty two point four one seven." },
] as const;
const groupLabel = (segmentId: string): string => {
  if (segmentId.startsWith("phrase.exact")) return "Exact response";
  if (segmentId.startsWith("phrase.scope") || segmentId === "phrase.from" || segmentId === "phrase.off") return "Context";
  if (segmentId.startsWith("unit.")) return "Timing units";
  return "Pace phrases";
};
type RenderedPace = { segmentIds?: string[]; voiceLine?: { segmentIds?: string[] }; text?: string; [key: string]: unknown };
const stateDefinitions = [
  { id: "fastest-in-class", label: "Fastest", detail: "Benchmark beaten", priority: "high", next: "setting-race-pace", color: "text-app-signal-cyan" },
  { id: "setting-race-pace", label: "Race pace", detail: "Setting benchmark", priority: "normal", next: "within-class-pace", color: "text-app-text" },
  { id: "within-class-pace", label: "Within pace", detail: "Small delta", priority: "low", next: "off-class-pace", color: "text-app-text" },
  { id: "off-class-pace", label: "Off pace", detail: "Recoverable delta", priority: "normal", next: "outlier-lap", color: "text-app-signal-amber" },
  { id: "outlier-lap", label: "Outlier", detail: "Large delta", priority: "high", next: "fastest-in-class", color: "text-app-signal-red" },
] as const;
type EngineEvent = { state: (typeof relations)[number]; outcome: "selected"; at: string };

const stateDefinitionFor = (state: (typeof relations)[number]) => stateDefinitions.find((item) => item.id === state)!;

const sampleDeltaText = (deltaMs: number): string => formatLiveEngineerDeltaText(deltaMs);
export function DevRaceEngineerSpeechPanel() {
  const [relation, setRelation] = useState<(typeof relations)[number]>("within-class-pace");
  const [voiceMode, setVoiceMode] = useState<"automatic" | "exact-response">("automatic");
  const [sampleDeltaMs, setSampleDeltaMs] = useState(300);
  const [renderedSentenceText, setRenderedSentenceText] = useState<Record<string, string>>({});
  const [engineState, setEngineState] = useState<(typeof relations)[number]>("within-class-pace");
  const [engineEvents, setEngineEvents] = useState<EngineEvent[]>([]);
  const [engineBusy, setEngineBusy] = useState(false);
  const audio = useDevSpeechAudio(false);
  const groups = useMemo(() => {
    const grouped = new Map<string, SpeechClip[]>();
    for (const clip of audio.visibleLines) {
      const label = groupLabel(clip.segmentId);
      grouped.set(label, [...(grouped.get(label) ?? []), clip]);
    }
    return [...grouped.entries()];
  }, [audio.visibleLines]);
  const renderPace = async (nextRelation: (typeof relations)[number], scope: "class" | "overall" = "class"): Promise<RenderedPace> => {
    const response = await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relation: nextRelation, scope, playerLapNumber: 1, playerLapTimeMs: 60_000 + sampleDeltaMs, benchmarkLapTimeMs: 60_000, deltaMs: sampleDeltaMs, benchmarkKind: "session-best", voiceMode }) });
    return await response.json() as RenderedPace;
  };
  const segmentIdsFor = (rendered: RenderedPace): string[] | undefined => rendered.segmentIds ?? rendered.voiceLine?.segmentIds;
  const previewPace = async () => {
    const rendered = await renderPace(relation);
    audio.setResult(rendered);
    const segmentIds = segmentIdsFor(rendered);
    if (segmentIds) await audio.playSegments("pace", segmentIds);
  };
  const testState = async (nextState: (typeof relations)[number]) => {
    setEngineState(nextState);
    setRelation(nextState);
    setEngineBusy(true);
    const rendered = await renderPace(nextState);
    audio.setResult(rendered);
    setEngineEvents((events) => [{ state: nextState, outcome: "selected" as const, at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }, ...events].slice(0, 4));
    setEngineBusy(false);
  };
  const playSentence = async (example: (typeof sentenceExamples)[number]) => {
    const rendered = example.kind === "lap-time"
      ? await (await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "lap-time", lapTimeMs: 92_417 }) })).json() as RenderedPace
      : await renderPace(example.relation, example.scope);
    audio.setResult(rendered);
    if (rendered.text) setRenderedSentenceText((previous) => ({ ...previous, [example.id]: rendered.text! }));
    const segmentIds = segmentIdsFor(rendered);
    if (segmentIds) await audio.playQwenSegments(`qwen-sentence-${example.id}`, segmentIds);
  };
  const selectedDefinition = stateDefinitionFor(engineState);
  return <div className="h-full overflow-y-auto p-6">
    <div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Race Engineer Speech</h2><p className="text-sm text-app-text-muted">CrewChief-style pace state testing, audio, and decision trace.</p></div><Button variant="outline" onClick={() => void audio.loadCatalog()}>Refresh catalog</Button></div>
    <section className="mt-6 rounded border border-app-border p-4"><div className="flex items-start justify-between gap-4"><div><h3 className="font-semibold">State testing</h3><p className="mt-1 text-xs text-app-text-muted">Select a runtime state, inspect arbitration, then preview its rendered callout.</p></div><span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${engineBusy ? "border-app-signal-amber text-app-signal-amber" : "border-app-signal-cyan text-app-signal-cyan"}`}>{engineBusy ? "Evaluating" : "Engine online"}</span></div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]"><div><div className="grid gap-2 sm:grid-cols-5">{stateDefinitions.map((item) => <button key={item.id} type="button" onClick={() => setEngineState(item.id)} className={`rounded border px-2 py-3 text-left transition-colors ${engineState === item.id ? "border-app-accent bg-app-accent/15" : "border-app-border bg-app-surface-alt hover:border-app-accent/60"}`} aria-pressed={engineState === item.id}><span className={`block text-xs font-semibold ${item.color}`}>{item.label}</span><span className="mt-1 block text-[10px] text-app-text-muted">{item.detail}</span><span className="mt-2 block text-[10px] uppercase tracking-wide text-app-text-muted">{item.priority} priority</span></button>)}</div>
        <div className="mt-4 flex flex-wrap items-center gap-3"><select aria-label="Engine state" value={engineState} onChange={(event) => setEngineState(event.target.value as (typeof relations)[number])}>{relations.map((item) => <option key={item}>{item}</option>)}</select><Button onClick={() => void testState(engineState)} disabled={engineBusy || audio.catalog === null}>Test selected state</Button><Button variant="outline" onClick={audio.stop}>Stop</Button></div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded border border-app-border bg-app-surface-alt p-3"><div className="text-[10px] uppercase tracking-wide text-app-text-muted">Selected state</div><div className="mt-1 font-semibold">{engineState}</div></div><div className="rounded border border-app-border bg-app-surface-alt p-3"><div className="text-[10px] uppercase tracking-wide text-app-text-muted">Priority</div><div className={`mt-1 font-semibold ${selectedDefinition.color}`}>{selectedDefinition.priority}</div></div><div className="rounded border border-app-border bg-app-surface-alt p-3"><div className="text-[10px] uppercase tracking-wide text-app-text-muted">Queue / trace</div><div className="mt-1 font-semibold">{engineEvents.length} recent</div></div></div></div>
        <aside aria-label="Race engineer state logic diagram" className="rounded border border-app-border bg-app-surface-alt p-3"><h4 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">Logic diagram</h4><div className="mt-3 space-y-1">{stateDefinitions.map((item, index) => <div key={item.id}><button type="button" onClick={() => setEngineState(item.id)} className={`flex w-full items-center justify-between rounded border px-2 py-2 text-left text-[10px] ${engineState === item.id ? "border-app-accent bg-app-accent/15" : "border-app-border"}`}><span className="font-semibold">{item.label}</span><span className="text-app-text-muted">{item.priority}</span></button>{index < stateDefinitions.length - 1 && <div className="pl-3 text-[10px] leading-3 text-app-text-muted">↓ next: {item.next}</div>}</div>)}</div><div className="mt-3 border-t border-app-border pt-3 text-[10px] text-app-text-muted">candidate → priority → cooldown → selected</div></aside></div>
      <div className="mt-4 border-t border-app-border pt-3"><div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-app-text-muted"><span>Decision trace</span><span>{engineEvents.length ? `${engineEvents.length} events` : "No tests run"}</span></div><div className="mt-2 flex flex-wrap gap-2">{engineEvents.length ? engineEvents.map((event, index) => <span key={`${event.at}-${index}`} className="rounded border border-app-border px-2 py-1 text-[10px]"><b>{event.state}</b> · {event.outcome} · {event.at}</span>) : <span className="text-xs text-app-text-muted">Test state to populate runtime decisions.</span>}</div></div>
    </section>
    <div className="mt-6 flex flex-wrap items-end gap-2"><select aria-label="Relation" value={relation} onChange={(event) => setRelation(event.target.value as (typeof relations)[number])}>{relations.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Voice mode" value={voiceMode} onChange={(event) => setVoiceMode(event.target.value as "automatic" | "exact-response") }><option value="automatic">Automatic</option><option value="exact-response">Exact pace</option></select><label className="flex flex-col gap-1 text-xs text-app-text-muted">Sample delta (ms)<input aria-label="Sample delta (ms)" type="number" min="1" step="100" value={sampleDeltaMs} onChange={(event) => setSampleDeltaMs(Math.max(1, Number(event.target.value) || 1))} className="h-9 w-32 rounded border border-app-border bg-app-surface px-2 text-sm text-app-text" /><span>{sampleDeltaText(sampleDeltaMs)}</span></label><Button onClick={() => void previewPace()}>Preview pace</Button><Button onClick={audio.stop}>Stop</Button></div>
    <p className="mt-3 text-xs text-app-text-muted">{audio.catalog ? `${audio.visibleLines.length} Qwen clips · ${audio.catalog.model ?? "Qwen"} · validation ${audio.catalog.validation ? "passed" : "pending"} · ${audio.catalog.fullLines.length} Qwen full lines` : "Loading Qwen audio catalog…"}</p>
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section className="mt-6 space-y-5"><div><h3 className="font-semibold">Sentences</h3><p className="mt-1 text-xs text-app-text-muted">Complete examples sent to drivers, including lap-time deltas.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sentenceExamples.map((example) => <div key={example.id} className="flex items-center justify-between gap-3 rounded border border-app-border bg-app-surface-alt p-3"><div><div className="font-medium">{renderedSentenceText[example.id] ?? example.label.replace("point three seconds", sampleDeltaText(sampleDeltaMs))}</div><div className="mt-1 text-xs text-app-text-muted">{example.kind === "lap-time" ? "completed lap time · sample 1:32.417" : `${example.relation} · sample delta ${sampleDeltaText(sampleDeltaMs)}`}</div></div><Button variant="app-outline" size="app-sm" aria-label={`Play Qwen sentence: ${example.label}`} onClick={() => void playSentence(example)}>Play Qwen</Button></div>)}</div></div>
      <div><h3 className="font-semibold">Individual Qwen clips</h3><p className="mt-1 text-xs text-app-text-muted">Atomic Qwen voice clips used to build complete sentences.</p><div className="mt-3 space-y-5">{groups.map(([label, clips]) => <div key={label}><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{label}</h4><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{clips.map((clip) => <div key={clip.segmentId} className="flex items-center gap-3 rounded border border-app-border bg-app-surface-alt p-3"><div className="min-w-0 flex-1"><div className="font-medium truncate">{clip.spokenText || clip.segmentId}</div><div className="mt-1 text-xs text-app-text-muted">{clip.segmentId} · {clip.durationMs} ms</div></div><Button variant="app-outline" size="icon-sm" aria-label={`Play Qwen clip: ${clip.spokenText || clip.segmentId}`} onClick={() => void audio.playQwenClip(`qwen-clip-${clip.segmentId}`, clip.segmentId)}><span aria-hidden="true">Q</span></Button></div>)}</div></div>)}</div></div>
    </section>
      {audio.result && <aside className="order-first h-fit rounded border border-app-border bg-app-surface-alt p-4 lg:order-last"><h3 className="font-semibold">Render JSON</h3><pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(audio.result, null, 2)}</pre></aside>}
    </div>
  </div>;
}
