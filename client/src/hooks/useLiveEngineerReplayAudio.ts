import { useCallback, useEffect, useRef, useState } from "react";
import { LiveEngineerAudioError, LiveEngineerAudioPlayer } from "../lib/live-engineer-audio";

type ReplayAudioRequest =
  | { id: string; kind: "segments"; values: readonly string[] }
  | { id: string; kind: "full-line"; values: string };

export function useLiveEngineerReplayAudio() {
  const contextRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<LiveEngineerAudioPlayer | null>(null);
  const operationRef = useRef(0);
  const queueRef = useRef<ReplayAudioRequest[]>([]);
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const drainingRef = useRef(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ensurePlayer = useCallback(() => {
    let context = contextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
      contextRef.current = context;
      playerRef.current = new LiveEngineerAudioPlayer({ audioContext: context });
    }
    return { context, player: playerRef.current! };
  }, []);

  const unlock = useCallback(async () => {
    const { context } = ensurePlayer();
    if (context.state === "suspended") await context.resume();
  }, [ensurePlayer]);

  const stop = useCallback(() => {
    operationRef.current += 1;
    queueRef.current = [];
    pendingIdsRef.current.clear();
    drainingRef.current = false;
    playerRef.current?.stop();
    setPlayingId(null);
  }, []);

  const enqueue = useCallback((item: ReplayAudioRequest) => {
    if (pendingIdsRef.current.has(item.id)) return;
    pendingIdsRef.current.add(item.id);
    queueRef.current.push(item);
    if (drainingRef.current) return;
    drainingRef.current = true;
    const operation = operationRef.current;
    void ((async () => {
      try {
        while (queueRef.current.length && operationRef.current === operation) {
          const next = queueRef.current.shift()!;
          setPlayingId(next.id);
          try {
            if (next.kind === "segments") await playerRef.current!.play(next.values);
            else await playerRef.current!.playFullLine(next.values);
          } catch (cause) {
            if (operationRef.current !== operation) return;
            const message = cause instanceof LiveEngineerAudioError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : "Audio playback failed";
            setError(message);
          } finally {
            if (operationRef.current === operation) pendingIdsRef.current.delete(next.id);
          }
        }
      } finally {
        if (operationRef.current === operation) {
          drainingRef.current = false;
          setPlayingId(null);
        }
      }
    })());
  }, []);

  const play = useCallback(async (id: string, segmentIds: readonly string[]) => {
    if (segmentIds.length === 0) return;
    const operation = operationRef.current;
    const { context } = ensurePlayer();
    if (context.state === "suspended") await context.resume();
    if (operationRef.current !== operation) return;
    setError(null);
    enqueue({ id, kind: "segments", values: segmentIds });
  }, [ensurePlayer, enqueue]);

  const playFullLine = useCallback(async (id: string, lineId: string) => {
    const operation = operationRef.current;
    const { context } = ensurePlayer();
    if (context.state === "suspended") await context.resume();
    if (operationRef.current !== operation) return;
    setError(null);
    enqueue({ id, kind: "full-line", values: lineId });
  }, [ensurePlayer, enqueue]);

  const clearError = useCallback(() => setError(null), []);

  useEffect(() => () => {
    operationRef.current += 1;
    queueRef.current = [];
    drainingRef.current = false;
    pendingIdsRef.current.clear();
    playerRef.current?.stop();
    void contextRef.current?.close();
    contextRef.current = null;
    playerRef.current = null;
  }, []);

  return { play, playFullLine, stop, unlock, playingId, error, clearError };
}
