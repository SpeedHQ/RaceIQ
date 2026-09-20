import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LiveEngineerAudioPlayer, type LiveEngineerAudioOptions } from "../../lib/live-engineer-audio";

export type SpeechClip = { segmentId: string; spokenText: string; path: string; durationMs: number; sha256: string };
export type SpeechQwenClip = SpeechClip & { url: string };
export type SpeechFullLine = { lineId: string; spokenText: string; path: string; url: string; durationMs: number; sha256: string };
export type SpeechOracle = { oracleId: string; text: string; path: string; durationMs: number; sha256: string; recipeSegmentIds: string[] };
export type SpeechCatalog = { catalogVersion: string; model: string | null; qwenClips: SpeechQwenClip[]; fullLines: SpeechFullLine[]; oracles?: SpeechOracle[]; validation: boolean; fullLineValidation: { passed: boolean; failures: string[] } | null };

export interface DevSpeechAudio {
  catalog: SpeechCatalog | null;
  visibleLines: SpeechQwenClip[];
  result: Record<string, unknown> | null;
  setResult: Dispatch<SetStateAction<Record<string, unknown> | null>>;
  playing: string | null;
  loadCatalog: (signal?: AbortSignal) => Promise<void>;
  stop: () => void;
  beginPreview: () => () => boolean;
  playSegments: (id: string, segmentIds: readonly string[], source?: LiveEngineerAudioOptions["catalog"]) => Promise<void>;
  playFullLine: (id: string, lineId: string, source?: LiveEngineerAudioOptions["catalog"]) => Promise<void>;
  playOracle: (id: string, oracleId: string, source?: LiveEngineerAudioOptions["catalog"]) => Promise<void>;
  playQwenClip: (id: string, segmentId: string) => Promise<void>;
  playQwenSegments: (id: string, segmentIds: readonly string[]) => Promise<void>;
}

export function useDevSpeechAudio(spotter: boolean): DevSpeechAudio {
  const [catalog, setCatalog] = useState<SpeechCatalog | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const requestRef = useRef(0);
  const disposeRef = useRef<(() => void) | null>(null);
  const stop = () => {
    requestRef.current += 1;
    disposeRef.current?.();
    disposeRef.current = null;
    setPlaying(null);
  };
  // A pending server preview must not start after another preview or Stop wins.
  const beginPreview = () => {
    stop();
    const request = requestRef.current;
    return () => request === requestRef.current;
  };
  const loadCatalog = async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/dev/live-engineer/catalog", { signal });
      if (!response.ok) throw new Error("Qwen audio catalog unavailable");
      const next = await response.json() as SpeechCatalog;
      if (!signal?.aborted) setCatalog(next);
    } catch (error) {
      if (!signal?.aborted) setResult({ error: error instanceof Error ? error.message : String(error) });
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void loadCatalog(controller.signal);
    return () => { controller.abort(); stop(); };
  }, []);
  const visibleLines = useMemo(() => catalog?.qwenClips.filter((clip) => spotter === clip.segmentId.startsWith("spotter.")) ?? [], [catalog, spotter]);
  const playAudio = async (id: string, play: (player: LiveEngineerAudioPlayer) => Promise<void>, source?: LiveEngineerAudioOptions["catalog"]): Promise<void> => {
    const isCurrent = beginPreview();
    setPlaying(id);
    setResult((current) => current?.error ? null : current);
    let dispose: (() => void) | undefined;
    try {
      // Preview-only isolation: closing this context also silences work still preparing.
      const context = new AudioContext();
      const controller = new AbortController();
      let player: LiveEngineerAudioPlayer | undefined;
      dispose = () => {
        controller.abort();
        player?.stop();
        if (context.state !== "closed") void context.close().catch(() => {});
      };
      disposeRef.current = dispose;
      player = new LiveEngineerAudioPlayer({
        audioContext: context,
        catalog: source,
        allowUnapprovedCatalog: source?.version === "live-engineer-qwen-v3",
        fetchImpl: (input, init) => fetch(input, { ...init, signal: controller.signal }),
      });
      // Resume during the click gesture, before catalog/network preparation.
      await context.resume();
      if (!isCurrent()) return;
      await play(player);
    } catch (error) {
      if (isCurrent()) setResult({ error: error instanceof Error ? error.message : String(error), hint: "Browser audio permission or asset load failed" });
    } finally {
      dispose?.();
      if (isCurrent()) {
        disposeRef.current = null;
        setPlaying(null);
      }
    }
  };
  const playSegments = (id: string, segmentIds: readonly string[], source?: LiveEngineerAudioOptions["catalog"]): Promise<void> => playAudio(id, (player) => player.play(segmentIds), source);
  const playFullLine = (id: string, lineId: string, source?: LiveEngineerAudioOptions["catalog"]): Promise<void> => playAudio(id, (player) => player.playFullLine(lineId), source);
  const playOracle = (id: string, oracleId: string, source?: LiveEngineerAudioOptions["catalog"]): Promise<void> => playAudio(id, (player) => player.playOracle(oracleId), source);
  const playQwenClip = (id: string, segmentId: string): Promise<void> => playSegments(id, [segmentId]);
  const playQwenSegments = (id: string, segmentIds: readonly string[]): Promise<void> => playSegments(id, segmentIds);
  return { catalog, visibleLines, result, setResult, playing, loadCatalog, stop, beginPreview, playSegments, playFullLine, playOracle, playQwenClip, playQwenSegments };
}
