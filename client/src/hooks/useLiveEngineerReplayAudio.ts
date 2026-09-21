import { useCallback, useEffect, useRef, useState } from "react";
import { LiveEngineerAudioError, LiveEngineerAudioPlayer } from "../lib/live-engineer-audio";

export function useLiveEngineerReplayAudio() {
  const contextRef = useRef<AudioContext | null>(null);
  const playerRef = useRef<LiveEngineerAudioPlayer | null>(null);
  const operationRef = useRef(0);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ensurePlayer = useCallback(() => {
    let context = contextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContext();
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
    playerRef.current?.stop();
    setPlayingId(null);
  }, []);

  const play = useCallback(async (id: string, segmentIds: readonly string[]) => {
    if (segmentIds.length === 0) return;
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const { context, player } = ensurePlayer();
    player.stop();
    setError(null);
    setPlayingId(id);
    try {
      if (context.state === "suspended") await context.resume();
      await player.play(segmentIds);
      if (operationRef.current === operation) setPlayingId(null);
    } catch (cause) {
      if (operationRef.current !== operation) return;
      setPlayingId(null);
      const message = cause instanceof LiveEngineerAudioError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : "Audio playback failed";
      setError(message);
    }
  }, [ensurePlayer]);
  const playFullLine = useCallback(async (id: string, lineId: string) => {
    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const { context, player } = ensurePlayer();
    player.stop();
    setError(null);
    setPlayingId(id);
    try {
      if (context.state === "suspended") await context.resume();
      await player.playFullLine(lineId);
      if (operationRef.current === operation) setPlayingId(null);
    } catch (cause) {
      if (operationRef.current !== operation) return;
      setPlayingId(null);
      const message = cause instanceof LiveEngineerAudioError ? `${cause.code}: ${cause.message}` : cause instanceof Error ? cause.message : "Audio playback failed";
      setError(message);
    }
  }, [ensurePlayer]);
  const clearError = useCallback(() => setError(null), []);


  useEffect(() => () => {
    operationRef.current += 1;
    playerRef.current?.stop();
    void contextRef.current?.close();
  }, []);

  return { play, playFullLine, stop, unlock, playingId, error, clearError };
}
