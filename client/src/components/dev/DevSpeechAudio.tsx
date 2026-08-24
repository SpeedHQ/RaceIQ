import { useEffect, useMemo, useRef, useState } from "react";

export type SpeechClip = { segmentId: string; spokenText: string; path: string; durationMs: number; sha256: string };
export type SpeechQwenClip = SpeechClip & { url: string };
export type SpeechFullLine = { lineId: string; spokenText: string; path: string; url: string; durationMs: number; sha256: string };
export type SpeechCatalog = { catalogVersion: string; pipelineVersion: string | null; validation: boolean; clipCount: number; lines: SpeechClip[]; qwenClips: SpeechQwenClip[]; fullLineModel: string | null; fullLineValidation: { passed: boolean; failures: string[] } | null; fullLines: SpeechFullLine[] };

export function useDevSpeechAudio(spotter: boolean) {
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement[]>([]);
  const stop = () => {
    for (const audio of audioRef.current) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    }
    audioRef.current = [];
    setPlaying(null);
  };
  const loadCatalog = async () => setCatalog(await (await fetch("/api/dev/live-engineer/catalog")).json() as SpeechCatalog);
  useEffect(() => {
    void loadCatalog();
    return () => stop();
  }, []);
  const visibleLines = useMemo(() => catalog?.lines.filter((clip) => spotter === clip.segmentId.startsWith("spotter.")) ?? [], [catalog, spotter]);
  const playSegments = (id: string, segmentIds: string[]): Promise<void> => {
    stop();
    const clips = segmentIds.map((segmentId) => catalog?.lines.find((clip) => clip.segmentId === segmentId)).filter((clip): clip is SpeechClip => clip !== undefined);
    if (clips.length !== segmentIds.length) {
      setResult({ error: "Audio clip unavailable", segmentIds });
      return Promise.resolve();
    }
    setPlaying(id);
    const audios = clips.map((clip) => new Audio(`/audio/live-engineer/v1/${clip.path}`));
    audioRef.current = audios;
    return new Promise((resolve) => {
      let index = 0;
      const finish = () => { audioRef.current = []; setPlaying(null); resolve(); };
      const playNext = () => {
        const audio = audios[index];
        if (!audio) { finish(); return; }
        audio.onended = () => { index += 1; playNext(); };
        audio.onerror = () => { setResult({ error: "Audio asset failed to load", clip: clips[index]?.segmentId }); finish(); };
        void audio.play().catch((error: unknown) => { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); finish(); });
      };
      playNext();
    });
  };
  const playFullLine = (id: string, lineId: string): Promise<void> => {
    stop();
    const line = catalog?.fullLines.find((item) => item.lineId === lineId);
    if (!line) {
      setResult({ error: "Full-line audio unavailable", lineId });
      return Promise.resolve();
    }
    setPlaying(id);
    const audio = new Audio(line.url);
    audioRef.current = [audio];
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = () => { audioRef.current = []; setPlaying(null); resolve(); };
    audio.onended = finish;
    audio.onerror = () => { setResult({ error: "Full-line audio failed to load", lineId }); finish(); };
    void audio.play().catch((error: unknown) => { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); finish(); });
    return promise;
  };
  const playQwenClip = (id: string, segmentId: string): Promise<void> => {
    stop();
    const clip = catalog?.qwenClips.find((item) => item.segmentId === segmentId);
    if (!clip) {
      setResult({ error: "Qwen audio clip unavailable", segmentId });
      return Promise.resolve();
    }
    setPlaying(id);
    const audio = new Audio(clip.url);
    audioRef.current = [audio];
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = () => { audioRef.current = []; setPlaying(null); resolve(); };
    audio.onended = finish;
    audio.onerror = () => { setResult({ error: "Qwen audio clip failed to load", segmentId }); finish(); };
    void audio.play().catch((error: unknown) => { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); finish(); });
    return promise;
  };
  const playQwenSegments = (id: string, segmentIds: string[]): Promise<void> => {
    stop();
    const clips = segmentIds.map((segmentId) => catalog?.qwenClips.find((clip) => clip.segmentId === segmentId)).filter((clip): clip is SpeechQwenClip => clip !== undefined);
    if (clips.length !== segmentIds.length) {
      setResult({ error: "Qwen audio clip unavailable", segmentIds });
      return Promise.resolve();
    }
    setPlaying(id);
    const audios = clips.map((clip) => new Audio(clip.url));
    audioRef.current = audios;
    const { promise, resolve } = Promise.withResolvers<void>();
    let index = 0;
    const finish = () => { audioRef.current = []; setPlaying(null); resolve(); };
    const playNext = () => {
      const audio = audios[index];
      if (!audio) { finish(); return; }
      audio.onended = () => { index += 1; playNext(); };
      audio.onerror = () => { setResult({ error: "Qwen audio clip failed to load", clip: clips[index]?.segmentId }); finish(); };
      void audio.play().catch((error: unknown) => { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); finish(); });
    };
    playNext();
    return promise;
  };
  return { catalog, visibleLines, result, setResult, playing, loadCatalog, stop, playSegments, playFullLine, playQwenClip, playQwenSegments };
}
