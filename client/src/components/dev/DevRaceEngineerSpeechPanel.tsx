import { useState } from "react";
import { Button } from "../ui/button";
import { useDevSpeechAudio } from "./DevSpeechAudio";

const relations = ["fastest-in-class", "setting-race-pace", "within-class-pace", "off-class-pace", "outlier-lap"] as const;

export function DevRaceEngineerSpeechPanel() {
  const [relation, setRelation] = useState<(typeof relations)[number]>("within-class-pace");
  const [voiceMode, setVoiceMode] = useState<"automatic" | "exact-response">("automatic");
  const audio = useDevSpeechAudio(false);
  const previewPace = async () => {
    const response = await fetch("/api/dev/live-engineer/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relation, scope: "class", playerLapNumber: 1, playerLapTimeMs: 60_300, benchmarkLapTimeMs: 60_000, deltaMs: 300, benchmarkKind: "session-best", voiceMode }) });
    const rendered = await response.json() as { segmentIds?: string[]; [key: string]: unknown };
    audio.setResult(rendered);
    if (rendered.segmentIds) await audio.playSegments("pace", rendered.segmentIds);
  };
  return <div className="h-full overflow-y-auto p-6"><div className="flex items-start justify-between gap-4"><div><h2 className="text-lg font-semibold">Race Engineer Speech</h2><p className="text-sm text-app-text-muted">Race engineer pace callouts and deterministic voice atoms.</p></div><Button onClick={() => void audio.loadCatalog()}>Refresh catalog</Button></div><div className="mt-6 flex flex-wrap gap-2"><select aria-label="Relation" value={relation} onChange={(event) => setRelation(event.target.value as (typeof relations)[number])}>{relations.map((item) => <option key={item}>{item}</option>)}</select><select aria-label="Voice mode" value={voiceMode} onChange={(event) => setVoiceMode(event.target.value as "automatic" | "exact-response") }><option value="automatic">Automatic</option><option value="exact-response">Exact pace</option></select><Button onClick={() => void previewPace()}>Preview pace</Button><Button onClick={audio.stop}>Stop</Button></div>{audio.result && <pre className="mt-4 whitespace-pre-wrap rounded border border-app-border p-4 text-xs">{JSON.stringify(audio.result, null, 2)}</pre>}<p className="mt-3 text-xs text-app-text-muted">{audio.catalog ? `${audio.visibleLines.length} clips · ${audio.catalog.pipelineVersion ?? "no generated catalog"} · validation ${audio.catalog.validation ? "passed" : "pending"}` : "Loading audio catalog…"}</p><div className="mt-6 overflow-hidden rounded border border-app-border"><div className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] gap-3 border-b border-app-border bg-app-surface-alt px-3 py-2 text-xs font-semibold"><span>Line</span><span>Audio</span><span>Status</span></div>{audio.visibleLines.map((clip) => <div key={clip.segmentId} className="grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_8rem] items-center gap-3 border-b border-app-border px-3 py-3 text-xs"><div><div className="font-medium">{clip.segmentId}</div><div className="text-app-text-muted">{clip.spokenText}</div></div><audio controls preload="none" src={`/audio/live-engineer/v1/${clip.path}`} className="h-8 w-full" /><div className="text-app-text-muted">{clip.durationMs} ms</div></div>)}</div></div>;
}
