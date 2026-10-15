import type { SessionCaptureRecord } from "@raceiq/capture-formats/session/framing";
import type { GameId, LapWindow, Progress } from "./contract";
class PreparationFailure extends Error {
  readonly code: "FORMAT" | "GAME" | "IO";
  constructor(code: "FORMAT" | "GAME" | "IO", message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

const formatFailure = (message: string) => new PreparationFailure("FORMAT", message);
const gameFailure = (message: string) => new PreparationFailure("GAME", message);

export type DetectedLapWindow = Pick<LapWindow, "lapId" | "lapNumber" | "startByteOffset" | "frameCount">;

/** Host binds parser lifecycle and opaque checkpoint encoding; package owns scan and window policy. */
export interface SplitPreparationCodec<State> {
  readonly gameId: GameId;
  readonly appendsDelayedFinishFrame: boolean;
  createState(): State;
  captureCheckpoint?(state: State): Uint8Array | null;
  restoreCheckpoint?(state: State, payload: Uint8Array): State;
  parseFrame?(frame: Uint8Array, state: State): unknown;
  primeFrame?(frame: Uint8Array, state: State): unknown;
}

export interface SplitPreparationInput<State> {
  readonly windows: readonly DetectedLapWindow[];
  readonly source: (signal?: AbortSignal) => AsyncIterable<SessionCaptureRecord>;
  readonly codec: SplitPreparationCodec<State>;
  readonly bootstrapVersion: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: Progress) => void;
}

export async function prepareSplitWindows<State>(input: SplitPreparationInput<State>): Promise<LapWindow[]> {
  const { windows, codec, signal } = input;
  signal?.throwIfAborted();
  const ids = new Set<string>();
  let priorOffset = -1;
  for (const window of windows) {
    if (
      !window.lapId ||
      ids.has(window.lapId) ||
      !Number.isSafeInteger(window.startByteOffset) ||
      window.startByteOffset <= priorOffset ||
      !Number.isSafeInteger(window.frameCount) ||
      window.frameCount < 1 ||
      !Number.isSafeInteger(window.lapNumber) ||
      window.lapNumber < 1
    ) {
      throw formatFailure("Lap windows must have unique identities, ordered offsets, and valid frame counts");
    }
    ids.add(window.lapId);
    priorOffset = window.startByteOffset;
  }
  const prepared: LapWindow[] = windows.map((window) => ({ ...window, trailingContextFrameCount: codec.appendsDelayedFinishFrame ? 1 : 0 }));
  if (codec.captureCheckpoint && !codec.restoreCheckpoint) throw gameFailure(`Parser checkpoint restore unavailable for ${codec.gameId}`);
  let state: State | null = codec.captureCheckpoint ? codec.createState() : null;
  if (codec.captureCheckpoint && state == null) throw gameFailure(`Parser checkpoint state unavailable for ${codec.gameId}`);

  let windowIndex = 0,
    frameIndex = 0;
  let inContext = false;
  const windowStartFrameIndices: number[] = [];
  let records = 0;
  try {
    for await (const record of input.source(signal)) {
      signal?.throwIfAborted();
      input.onProgress?.({
        phase: "scan",
        records: ++records,
        frames: frameIndex + (record.kind === "frame" ? 1 : 0),
        bytes: record.endOffset,
        completedLapArtifacts: 0,
        totalLapArtifacts: windows.length,
      });
      if (record.kind === "segment-boundary") {
        inContext = false;
        if (codec.captureCheckpoint) {
          state = codec.createState();
          if (state == null) throw gameFailure(`Parser checkpoint state unavailable after segment boundary for ${codec.gameId}`);
        }
        continue;
      }
      if (record.kind === "segment-context") {
        inContext = true;
        continue;
      }
      if (record.kind === "segment-context-end") {
        inContext = false;
        continue;
      }
      if (record.kind === "parser-bootstrap") {
        if (codec.captureCheckpoint) {
          if (record.gameId !== codec.gameId || record.formatVersion !== input.bootstrapVersion) throw gameFailure("Parser bootstrap does not match split game");
          state = codec.restoreCheckpoint!(state!, record.payload);
        }
        inContext = false;
        continue;
      }
      if (record.kind !== "frame") continue;
      const window = windows[windowIndex];
      if (window) {
        if (record.offset > window.startByteOffset) throw formatFailure(`Lap window ${window.lapId} start is not aligned to a source frame`);
        if (record.offset === window.startByteOffset) {
          if (windowIndex > 0) {
            const previousWindow = windows[windowIndex - 1]!;
            const previousEnd = windowStartFrameIndices[windowIndex - 1]! + previousWindow.frameCount - 1;
            if (frameIndex <= previousEnd) {
              if (frameIndex !== previousEnd || previousWindow.frameCount < 2) throw formatFailure(`Lap windows overlap beyond one shared frame at ${window.lapId}`);
              prepared[windowIndex - 1] = { ...prepared[windowIndex - 1]!, frameCount: previousWindow.frameCount - 1, trailingContextFrameCount: 1 };
            }
          }
          windowStartFrameIndices[windowIndex] = frameIndex;
          if (codec.captureCheckpoint) {
            const checkpoint = codec.captureCheckpoint(state!);
            if (!checkpoint?.byteLength) throw gameFailure(`Parser checkpoint unavailable for ${codec.gameId} lap ${window.lapId}`);
            prepared[windowIndex] = { ...prepared[windowIndex]!, parserCheckpoint: Uint8Array.from(checkpoint) };
          }
          windowIndex++;
          if (windowIndex === windows.length) break;
        }
      }
      frameIndex++;
      const advanceState = inContext ? codec.parseFrame : (codec.primeFrame ?? codec.parseFrame);
      if (codec.captureCheckpoint && advanceState) {
        try {
          advanceState(record.frame, state!);
        } catch {
          /* malformed native frame must not stop parser-state progression */
        }
      }
    }
  } catch (error) {
    if (error instanceof PreparationFailure || signal?.aborted) throw error;
    throw new PreparationFailure(error instanceof Error && "code" in error ? "IO" : "FORMAT", error instanceof Error ? error.message : String(error), { cause: error });
  }
  if (windowIndex !== windows.length) throw formatFailure(`Capture ended before parser checkpoint for ${windows[windowIndex]!.lapId}`);
  return prepared;
}
