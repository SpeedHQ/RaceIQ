import { useEffect, useState } from "react";
import { renderLapTime } from "../../../../server/live-strategy/live-engineer-renderer";
import { Button } from "../ui/button";
import type { DevSpeechAudio } from "./DevSpeechAudio";

const v3Catalog = { url: "/audio/live-engineer/qwen-v3/manifest.json", version: "live-engineer-qwen-v3" };
type Sample = {
  id: string;
  label: string;
  lapTimeMs: number;
  spokenLapTimeMs: number;
  precision: "tenths" | "milliseconds";
  text: string;
  chunkedLineId: string;
  fullLineId: string;
};
type ComparisonRecipe = {
  approvalId: string;
  mode: "automatic" | "exact-response";
  text: string;
  segmentIds: string[];
  oracleId?: string;
  status?: string;
};
type ComparisonCatalog = {
  catalogVersion: string;
  model: string;
  samples?: Sample[];
  recipes?: ComparisonRecipe[];
  clips: { segmentId: string; spokenText: string; durationMs: number; sourceTranscript: string }[];
  oracles?: { oracleId: string; text: string; durationMs: number }[];
  fullLines: {
    lineId: string;
    spokenText: string;
    durationMs: number;
    segmentIds?: string[];
    joinTimesMs?: number[];
    gapMs?: number;
    overlapMs?: number;
  }[];
};
const formatLapTime = (ms: number, precision = 3): string => `${Math.floor(ms / 60_000)}:${((ms % 60_000) / 1000).toFixed(precision).padStart(precision + 3, "0")}`;

export function DevLapTimeComparison({ audio }: { audio: DevSpeechAudio }) {
  const [catalog, setCatalog] = useState<ComparisonCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(v3Catalog.url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Experimental v3 catalog unavailable (HTTP ${response.status}). Generate the comparison assets first.`);
        const manifest = await response.json() as ComparisonCatalog;
        if (manifest.catalogVersion !== v3Catalog.version || (!Array.isArray(manifest.samples) && !Array.isArray(manifest.recipes)) || !Array.isArray(manifest.fullLines) || !Array.isArray(manifest.clips)) {
          throw new Error("Experimental v3 catalog does not match the comparison format.");
        }
        for (const recipe of manifest.recipes ?? []) {
          if (!recipe.approvalId || !recipe.text || !Array.isArray(recipe.segmentIds) || !recipe.segmentIds.length
            || !recipe.segmentIds.every((id) => manifest.clips.some((clip) => clip.segmentId === id && clip.durationMs > 0))) {
            throw new Error("Experimental v3 catalog has an incomplete approval recipe.");
          }
        }
        for (const sample of manifest.samples ?? []) {
          if (!sample.id || !sample.label || !sample.text || !Number.isInteger(sample.lapTimeMs)
            || ![sample.chunkedLineId, sample.fullLineId].every((id) => manifest.fullLines.some((line) => line.lineId === id && line.spokenText === sample.text && line.durationMs > 0))) {
            throw new Error("Experimental v3 catalog has an incomplete sample or missing comparison audio.");
          }
        }
        if (!controller.signal.aborted) setCatalog(manifest);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
    return () => controller.abort();
  }, [attempt]);

  return (
    <section aria-labelledby="lap-fluency-title" className="rounded border border-app-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="lap-fluency-title" className="font-semibold">Live engineer qwen-v3 listening catalog</h3>
          <p className="mt-1 text-xs text-app-text-muted">Generated qwen-v3 clips, full lines, and approval recipes.</p>
        </div>
        <Button variant="outline" onClick={audio.stop}>Stop audio</Button>
      </div>
      <p className="mt-3 text-xs text-app-text-muted">
        Automatic and explicit pace requests use tenths. Playback uses exact-buffer joins.
      </p>
      {!catalog && !error && <p role="status" className="mt-3 text-sm">Loading experimental v3 samples…</p>}
      {error && (
        <div className="mt-3 flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-app-signal-red">{error}</p>
          <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>Reload comparison</Button>
        </div>
      )}
      {catalog && <p className="mt-3 text-xs text-app-text-muted">{catalog.samples?.length ?? catalog.recipes?.length ?? 0} recipes · {catalog.model} · {catalog.catalogVersion}</p>}
      <p role="status" aria-live="polite" className="mt-3 text-xs text-app-text-muted">
        {audio.playing?.startsWith("lap-comparison-") ? `Preparing / playing: ${audio.playing.slice("lap-comparison-".length)}` : "Comparison idle. Choose a variant to listen."}
      </p>
      {typeof audio.result?.error === "string" && <p role="alert" className="mt-2 text-sm text-app-signal-red">Preview error: {audio.result.error}</p>}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {(catalog?.samples ?? []).map((sample) => {
          const v2 = renderLapTime(sample.lapTimeMs);
          const chunked = catalog!.fullLines.find((line) => line.lineId === sample.chunkedLineId)!;
          return (
            <article key={sample.id} aria-label={sample.label} className="flex flex-col gap-3 rounded border border-app-border bg-app-surface-alt p-3">
              <div>
                <h4 className="font-medium">{sample.label}</h4>
                <p className="mt-1 text-xs text-app-text-muted">Recorded: {formatLapTime(sample.lapTimeMs)} · {sample.lapTimeMs} ms</p>
                <p className="mt-1 text-xs text-app-text-muted">V3 announced: {formatLapTime(sample.spokenLapTimeMs, sample.precision === "tenths" ? 1 : 3)} · {sample.precision}</p>
              </div>
              <p className="text-sm">V3: {sample.text}</p>
              <p className="text-xs text-app-text-muted">V2: {v2.text}</p>
              <div className="flex flex-wrap gap-2">
                <Button variant="app-outline" size="app-sm" onClick={() => void audio.playSegments(`lap-comparison-${sample.id}-v2`, v2.segmentIds)}>Current v2</Button>
                <Button variant="app-outline" size="app-sm" onClick={() => void audio.playFullLine(`lap-comparison-${sample.id}-v3-chunks`, sample.chunkedLineId, v3Catalog)}>V3 chunks</Button>
                <Button variant="app-outline" size="app-sm" onClick={() => void audio.playFullLine(`lap-comparison-${sample.id}-v3-whole`, sample.fullLineId, v3Catalog)}>V3 whole sentence</Button>
                {sample.lapTimeMs !== sample.spokenLapTimeMs && (
                  <Button variant="app-outline" size="app-sm" onClick={() => void audio.playSegments(`lap-comparison-${sample.id}-v2-same-value`, renderLapTime(sample.spokenLapTimeMs).segmentIds)}>V2 at rounded value</Button>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <h5 className="text-sm font-medium">Chunks in playback order</h5>
                <ol aria-label={`${sample.label} chunks`} className="flex flex-col gap-2">
                  {chunked.segmentIds!.map((segmentId, index) => {
                    const clip = catalog!.clips.find((entry) => entry.segmentId === segmentId)!;
                    const previewId = `lap-comparison-${sample.id}-chunk-${index}`;
                    return (
                      <li key={`${segmentId}-${index}`} className="flex flex-col items-start gap-1">
                        <Button variant="app-outline" size="app-sm" aria-label={`Play chunk ${index + 1}: ${clip.spokenText}`} aria-pressed={audio.playing === previewId}
                          onClick={() => void audio.playSegments(previewId, [segmentId], v3Catalog)}>
                          {index + 1}. {clip.spokenText}
                        </Button>
                        <p className="text-xs text-app-text-muted">{clip.durationMs} ms · {segmentId}</p>
                        <p className="text-xs text-app-text-muted">Cut from: “{clip.sourceTranscript}”</p>
                      </li>
                    );
                  })}
                </ol>
                <p className="text-xs text-app-text-muted">
                  Joins: {chunked.joinTimesMs!.map((time) => `${time.toFixed(1)} ms`).join(" · ")} from start.
                  {" "}Gap: {chunked.gapMs} ms · overlap: {chunked.overlapMs} ms.
                </p>
                <p className="text-xs text-app-text-muted">V3 chunks plays the offline-assembled file. Buttons above play each extracted chunk on its own.</p>
              </div>
            </article>
          );
        })}
      </div>
      {!!catalog?.recipes?.length && (
        <div className="mt-4 flex flex-col gap-2">
          <h4 className="font-medium">Approval recipes and oracles</h4>
          {catalog.recipes.map((recipe) => (
            <div key={recipe.approvalId} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{recipe.approvalId} · {recipe.mode} · {recipe.status ?? "not-listened"}</span>
              <Button variant="app-outline" size="app-sm" onClick={() => void audio.playSegments(`recipe-${recipe.approvalId}`, recipe.segmentIds, v3Catalog)}>Play chunks</Button>
              {recipe.oracleId && <Button variant="app-outline" size="app-sm" onClick={() => void audio.playOracle(`oracle-${recipe.approvalId}`, recipe.oracleId!, v3Catalog)}>Play oracle</Button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
