import { useEffect, useMemo, useRef, useState } from "react";
import { LiveEngineerAudioPlayer } from "../../lib/live-engineer-audio";

export type SpeechClip = { segmentId: string; spokenText: string; path: string; durationMs: number; sha256: string };
export type SpeechQwenClip = SpeechClip & { url: string };
export type SpeechFullLine = { lineId: string; spokenText: string; path: string; url: string; durationMs: number; sha256: string };
export type SpeechCatalog = { catalogVersion: string; model: string | null; qwenClips: SpeechQwenClip[]; fullLines: SpeechFullLine[]; validation: boolean; fullLineValidation: { passed: boolean; failures: string[] } | null };

export function useDevSpeechAudio(spotter: boolean) {
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement[]>([]);
  const playerRef = useRef<LiveEngineerAudioPlayer | null>(null);
  const stop = () => {
    for (const audio of audioRef.current) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    }
    audioRef.current = [];
    playerRef.current?.stop();
    setPlaying(null);
  };
  const loadCatalog = async () => setCatalog(await (await fetch("/api/dev/live-engineer/catalog")).json() as SpeechCatalog);
  useEffect(() => {
    void loadCatalog();
    return () => stop();
  }, []);
  const visibleLines = useMemo(() => catalog?.qwenClips.filter((clip) => spotter === clip.segmentId.startsWith("spotter.")) ?? [], [catalog, spotter]);
  const playSegments = (id: string, segmentIds: string[]): Promise<void> => {
    stop();
    const clips = segmentIds.map((segmentId) => catalog?.qwenClips.find((clip) => clip.segmentId === segmentId)).filter((clip): clip is SpeechQwenClip => clip !== undefined);
    if (clips.length !== segmentIds.length) {
      setResult({ error: "Qwen audio clip unavailable", segmentIds });
      return Promise.resolve();
    }
    setPlaying(id);
    const player = playerRef.current ?? (playerRef.current = new LiveEngineerAudioPlayer());
    return player.play(segmentIds).then(() => {
      setPlaying((current) => current === id ? null : current);
    }).catch((error: unknown) => {
      setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" });
      setPlaying((current) => current === id ? null : current);
    });
  };
  const playFullLine = (id: string, lineId: string): Promise<void> => {
    stop();
    const line = catalog?.fullLines.find((item) => item.lineId === lineId);
    if (!line) {
      setResult({ error: "Qwen full-line audio unavailable", lineId });
      return Promise.resolve();
    }
    setPlaying(id);
    const audio = new Audio(line.url);
    audioRef.current = [audio];
    const { promise, resolve } = Promise.withResolvers<void>();
    const finish = () => { audioRef.current = []; setPlaying(null); resolve(); };
    audio.onended = finish;
    audio.onerror = () => { setResult({ error: "Qwen full-line audio failed to load", lineId }); finish(); };
    void audio.play().catch((error: unknown) => { setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" }); finish(); });
    return promise;
  };
  const playQwenClip = (id: string, segmentId: string): Promise<void> => playSegments(id, [segmentId]);
  const playQwenSegments = (id: string, segmentIds: string[]): Promise<void> => playSegments(id, segmentIds);
  return { catalog, visibleLines, result, setResult, playing, loadCatalog, stop, playSegments, playFullLine, playQwenClip, playQwenSegments };
}
