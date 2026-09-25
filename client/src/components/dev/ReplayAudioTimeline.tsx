import { useEffect, useMemo, useState } from "react";
import type { LiveEngineerReplayAnnotationV1 } from "@shared/racing/live/engineer-replay-contracts";
import { AUDIO_START_LEAD_MS, getSegmentPauseMs } from "@/lib/live-engineer-audio";
import { cn } from "@/lib/utils";

const CATALOG_URL = "/audio/live-engineer/qwen-v3/manifest.json";
const FALLBACK_CLIP_MS = 1_000;
export const AUDIO_TIMELINE_WINDOW_MS = 10_000;

type CatalogEntry = { segmentId?: string; lineId?: string; durationMs: number; path?: string };
type DurationCatalog = { clips?: CatalogEntry[]; fullLines?: CatalogEntry[] };
const waveformCache = new Map<string, Promise<readonly number[]>>();

async function loadWaveform(path: string): Promise<readonly number[]> {
  let pending = waveformCache.get(path);
  if (!pending) {
    pending = (async () => {
      const response = await fetch(`/audio/live-engineer/qwen-v3/${path}`);
      if (!response.ok) throw new Error(`Audio clip unavailable (${response.status})`);
      const context = new AudioContext();
      try {
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const samples = buffer.getChannelData(0);
        const binCount = 32;
        return Array.from({ length: binCount }, (_, bin) => {
          const from = Math.floor((bin / binCount) * samples.length);
          const to = Math.max(from + 1, Math.floor(((bin + 1) / binCount) * samples.length));
          let peak = 0;
          for (let index = from; index < to; index += 1) peak = Math.max(peak, Math.abs(samples[index] ?? 0));
          return peak;
        });
      } finally {
        void context.close();
      }
    })();
    waveformCache.set(path, pending);
  }
  return pending;
}

function AudioWaveform({ path }: { path?: string }) {
  const [peaks, setPeaks] = useState<readonly number[]>([]);
  useEffect(() => {
    if (!path) return;
    let active = true;
    void loadWaveform(path).then((next) => { if (active) setPeaks(next); }).catch(() => {});
    return () => { active = false; };
  }, [path]);
  if (peaks.length === 0) return <span className="block h-4 border-y border-app-accent/30" aria-hidden="true" />;
  return (
    <svg className="h-4 w-full text-app-accent" viewBox={`0 0 ${peaks.length} 1`} preserveAspectRatio="none" aria-label="Audio waveform">
      {peaks.map((peak, index) => <rect key={index} x={index} y={(1 - peak) / 2} width={0.75} height={Math.max(0.04, peak)} fill="currentColor" />)}
    </svg>
  );
}

export interface ReplayAudioTimelineProps {
  events: readonly LiveEngineerReplayAnnotationV1[];
  startTimeMs: number;
  endTimeMs: number;
  currentTimeMs: number;
  playingId: string | null;
  onSeek: (event: LiveEngineerReplayAnnotationV1) => void;
  durationsMs?: Readonly<Record<string, number>>;
}

function formatTimelineTime(ms: number): string {
  const totalSeconds = Math.max(0, ms) / 1_000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}
export interface AudioTimelineSlice { id: string; kind: "lead" | "clip" | "pause"; durationMs: number; }

export function audioEventSlices(event: LiveEngineerReplayAnnotationV1, durations: Readonly<Record<string, number>>): AudioTimelineSlice[] {
  const ids = event.audioLineId ? [event.audioLineId] : event.segmentIds;
  const slices: AudioTimelineSlice[] = [{ id: "playback-lead", kind: "lead", durationMs: AUDIO_START_LEAD_MS }];
  ids.forEach((id, index) => {
    slices.push({ id, kind: "clip", durationMs: durations[id] ?? FALLBACK_CLIP_MS });
    const pauseMs = index < ids.length - 1 ? getSegmentPauseMs(id) : 0;
    if (pauseMs > 0) slices.push({ id: `pause-after-${id}`, kind: "pause", durationMs: pauseMs });
  });
  return slices;
}

export function audioEventDurationMs(event: LiveEngineerReplayAnnotationV1, durations: Readonly<Record<string, number>>): number {
  return audioEventSlices(event, durations).reduce((total, slice) => total + slice.durationMs, 0);
}

export function ReplayAudioTimeline({ events, startTimeMs, endTimeMs, currentTimeMs, playingId, onSeek, durationsMs }: ReplayAudioTimelineProps) {
  const [loadedDurations, setLoadedDurations] = useState<Readonly<Record<string, number>>>({});
  const [loadedPaths, setLoadedPaths] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (durationsMs) return;
    const controller = new AbortController();
    void fetch(CATALOG_URL, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<DurationCatalog> : Promise.reject(new Error(`Audio catalog unavailable (${response.status})`)))
      .then((catalog) => {
        const entries = [...(catalog.clips ?? []), ...(catalog.fullLines ?? [])];
        setLoadedDurations(Object.fromEntries(entries.flatMap((entry) => {
          const id = entry.segmentId ?? entry.lineId;
          return id && Number.isFinite(entry.durationMs) ? [[id, entry.durationMs]] : [];
        })));
        setLoadedPaths(Object.fromEntries(entries.flatMap((entry) => {
          const id = entry.segmentId ?? entry.lineId;
          return id && entry.path ? [[id, entry.path]] : [];
        })));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [durationsMs]);

  const durations = durationsMs ?? loadedDurations;
  const sessionDurationMs = Math.max(1, endTimeMs - startTimeMs);
  const windowDurationMs = Math.min(AUDIO_TIMELINE_WINDOW_MS, sessionDurationMs);
  const unclampedWindowStart = currentTimeMs - windowDurationMs / 2;
  const windowStartMs = Math.max(startTimeMs, Math.min(unclampedWindowStart, endTimeMs - windowDurationMs));
  const windowEndMs = windowStartMs + windowDurationMs;
  const visibleEvents = useMemo(() => events.filter((event) => event.timelineMs <= windowEndMs && event.timelineMs + audioEventDurationMs(event, durations) >= windowStartMs), [durations, events, windowEndMs, windowStartMs]);
  const visibleClipCount = visibleEvents.reduce((total, event) => total + audioEventSlices(event, durations).filter((slice) => slice.kind === "clip").length, 0);
  const playhead = Math.min(100, Math.max(0, ((currentTimeMs - windowStartMs) / windowDurationMs) * 100));

  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2" aria-label="Queued audio timeline">
      <div className="flex flex-col justify-center text-app-caption font-semibold uppercase tracking-wider text-app-text-muted">
        <span>Audio</span>
        <span className="font-mono font-normal normal-case">{visibleClipCount} clips · 10s</span>
      </div>
      <div className="relative h-14 overflow-hidden rounded border border-app-border bg-app-surface-alt/70">
        <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-app-border" />
        {[25, 50, 75].map((position) => <div key={position} className="absolute inset-y-0 border-l border-app-border/60" style={{ left: `${position}%` }} aria-hidden="true" />)}
        {visibleEvents.flatMap((event) => {
          const slices = audioEventSlices(event, durations);
          const elapsed = event.timelineMs - startTimeMs;
          const isPlaying = event.id === playingId;
          let offsetMs = 0;
          return slices.map((slice, index) => {
            const sliceStartMs = event.timelineMs + offsetMs;
            offsetMs += slice.durationMs;
            const left = Math.max(0, ((sliceStartMs - windowStartMs) / windowDurationMs) * 100);
            const width = Math.max(0.15, (slice.durationMs / windowDurationMs) * 100);
            const title = `${slice.kind}: ${slice.id} · ${slice.durationMs} ms · ${formatTimelineTime(sliceStartMs - startTimeMs)}`;
            if (slice.kind !== "clip") {
              return <div key={`${event.id}/${slice.id}/${index}`} className={cn("absolute inset-y-1 z-10 overflow-hidden rounded-sm border", slice.kind === "pause" ? "border-status-warning/70 bg-status-warning/25" : "border-app-text-muted/40 bg-app-text-muted/15")} style={{ left: `${left}%`, width: `${width}%` }} title={title}><span className="block truncate px-0.5 text-app-caption uppercase text-app-text-muted">{slice.kind}</span></div>;
            }
            return (
              <button
                key={`${event.id}/${slice.id}/${index}`}
                type="button"
                className={cn("absolute inset-y-1 z-10 min-w-px overflow-hidden rounded-sm border border-app-accent/55 bg-app-accent/15 text-left shadow-sm hover:z-20 hover:border-app-accent hover:bg-app-accent/25", sliceStartMs < currentTimeMs && !isPlaying && "opacity-55", isPlaying && "border-status-success bg-status-success/20 ring-1 ring-status-success")}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={title}
                aria-label={`Seek to clip ${slice.id} at ${formatTimelineTime(elapsed)}`}
                onClick={() => onSeek(event)}
              >
                <span className="block truncate px-1 text-app-caption font-semibold leading-3">{slice.id}</span>
                <AudioWaveform path={loadedPaths[slice.id]} />
                <span className="block truncate px-1 font-mono text-app-caption leading-3 text-app-text-muted">{(slice.durationMs / 1_000).toFixed(2)}s</span>
              </button>
            );
          });
        })}
        <div className="pointer-events-none absolute inset-y-0 z-30 w-px bg-status-warning shadow-[0_0_5px_var(--status-warning)]" style={{ left: `${playhead}%` }} aria-hidden="true" />
      </div>
    </div>
  );
}
