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

const sampleDeltaText = (deltaMs: number): string => formatLiveEngineerDeltaText(deltaMs);
export function DevRaceEngineerSpeechPanel() {
  const [relation, setRelation] = useState<(typeof relations)[number]>("within-class-pace");
  const [voiceMode, setVoiceMode] = useState<"automatic" | "exact-response">("automatic");
  const [sampleDeltaMs, setSampleDeltaMs] = useState(300);
  const [renderedSentenceText, setRenderedSentenceText] = useState<Record<string, string>>({});
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
  const playSentence = async (example: (typeof sentenceExamples)[number]) => {
    const rendered = example.kind === "lap-time"
      ? await (await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "lap-time", lapTimeMs: 92_417 }) })).json() as RenderedPace
      : await renderPace(example.relation, example.scope);
    audio.setResult(rendered);
    if (rendered.text) setRenderedSentenceText((previous) => ({ ...previous, [example.id]: rendered.text! }));
    const fullLine = audio.catalog?.fullLines.find((line) => line.lineId === example.id);
    if (fullLine) {
      await audio.playFullLine(`sentence-${example.id}`, fullLine.lineId);
      return;
    }
    const segmentIds = segmentIdsFor(rendered);
    if (segmentIds) await audio.playSegments(`sentence-${example.id}`, segmentIds);
  };
  return <div className="h-full overflow-y-auto p-6">
    <div className="mt-6 flex flex-wrap items-end gap-2"><select aria-label="Relation" value={relation} onChange={(event) => setRelation(event.target.value as (typeof relations)[number])}>{relations.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Voice mode" value={voiceMode} onChange={(event) => setVoiceMode(event.target.value as "automatic" | "exact-response") }><option value="automatic">Automatic</option><option value="exact-response">Exact pace</option></select><label className="flex flex-col gap-1 text-xs text-app-text-muted">Sample delta (ms)<input aria-label="Sample delta (ms)" type="number" min="1" step="100" value={sampleDeltaMs} onChange={(event) => setSampleDeltaMs(Math.max(1, Number(event.target.value) || 1))} className="h-9 w-32 rounded border border-app-border bg-app-surface px-2 text-sm text-app-text" /><span>{sampleDeltaText(sampleDeltaMs)}</span></label><Button onClick={() => void previewPace()}>Preview pace</Button><Button onClick={audio.stop}>Stop</Button></div>
    <p className="mt-3 text-xs text-app-text-muted">{audio.catalog ? `${audio.visibleLines.length} clips · ${audio.catalog.pipelineVersion ?? "no generated catalog"} · validation ${audio.catalog.validation ? "passed" : "pending"} · ${audio.catalog.fullLines.length} Qwen full lines${audio.catalog.fullLineModel ? ` · ${audio.catalog.fullLineModel}` : ""}` : "Loading audio catalog…"}</p>
    <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <section className="mt-6 space-y-5"><div><h3 className="font-semibold">Sentences</h3><p className="mt-1 text-xs text-app-text-muted">Complete examples sent to drivers, including lap-time deltas.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{sentenceExamples.map((example) => <div key={example.id} className="flex items-center justify-between gap-3 rounded border border-app-border bg-app-surface-alt p-3"><div><div className="font-medium">{renderedSentenceText[example.id] ?? example.label.replace("point three seconds", sampleDeltaText(sampleDeltaMs))}</div><div className="mt-1 text-xs text-app-text-muted">{example.kind === "lap-time" ? "completed lap time · sample 1:32.417" : `${example.relation} · sample delta ${sampleDeltaText(sampleDeltaMs)}`}</div></div><Button className="shrink-0" variant="app-ghost" size="icon-sm" aria-label={`Play sentence: ${example.label}`} onClick={() => void playSentence(example)}><span aria-hidden="true">▶</span></Button></div>)}</div></div>
      <div><h3 className="font-semibold">Individual clips</h3><p className="mt-1 text-xs text-app-text-muted">Atomic voice clips used to build complete sentences.</p><div className="mt-3 space-y-5">{groups.map(([label, clips]) => <div key={label}><h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-app-text-muted">{label}</h4><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{clips.map((clip) => <div key={clip.segmentId} className="flex items-center gap-3 rounded border border-app-border bg-app-surface-alt p-3"><div className="min-w-0 flex-1"><div className="font-medium truncate">{clip.spokenText || clip.segmentId}</div><div className="mt-1 text-xs text-app-text-muted">{clip.segmentId} · {clip.durationMs} ms</div></div><Button className="shrink-0" variant="app-ghost" size="icon-sm" aria-label={`Play clip: ${clip.spokenText || clip.segmentId}`} onClick={() => void audio.playSegments(clip.segmentId, [clip.segmentId])}><span aria-hidden="true">{audio.playing === clip.segmentId ? "■" : "▶"}</span></Button><audio controls preload="none" src={`/audio/live-engineer/v1/${clip.path}`} className="hidden" /></div>)}</div></div>)}</div></div>
    </section>
      {audio.result && <aside className="order-first h-fit rounded border border-app-border bg-app-surface-alt p-4 lg:order-last"><h3 className="font-semibold">Render JSON</h3><pre className="mt-3 max-h-[32rem] overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(audio.result, null, 2)}</pre></aside>}
    </div>
  </div>;
}
