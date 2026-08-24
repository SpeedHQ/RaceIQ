import { useEffect, useMemo, useRef, useState } from "react";

export type SpeechClip = { segmentId: string; spokenText: string; path: string; durationMs: number; sha256: string };
export type SpeechCatalog = { catalogVersion: string; pipelineVersion: string | null; validation: boolean; clipCount: number; lines: SpeechClip[] };

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
  return { catalog, visibleLines, result, setResult, playing, loadCatalog, stop, playSegments };
}
