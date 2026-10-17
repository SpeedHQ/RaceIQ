import { runSplitWorker, type WorkerMessage, type Progress } from "@raceiq/capture-splitting";
import { getServerGame } from "@raceiq/backend-core/games/registry";
import type { SessionCaptureSource } from "@raceiq/backend-core/session-capture/source-loader";
import { prepareLapWindowsForSplit, type DetectedLapWindow } from "./split-windows";

type SplitProgressMessage = Extract<WorkerMessage, { type: "progress" }>;

export interface SessionCaptureSplitInput {
  jobId: string;
  attemptId: number;
  sourceRevision: string;
  outputDirectory: string;
  source: SessionCaptureSource;
  windows: readonly DetectedLapWindow[];
}

/** Bind game codecs, prepare package-owned metadata, then delegate staging and verification. */
export async function runSessionCaptureSplit(
  input: SessionCaptureSplitInput,
  onProgress?: (message: SplitProgressMessage) => void,
  signal?: AbortSignal,
) {
  const game = getServerGame(input.source.gameId);
  let sequence = 0;
  const emitProgress = (progress: Progress) => onProgress?.({
    type: "progress", jobId: input.jobId, attemptId: String(input.attemptId), sequence: sequence++, progress,
  });
  const lapWindows = await prepareLapWindowsForSplit(input.source, input.windows, game, signal, emitProgress);
  return runSplitWorker({
    jobId: input.jobId,
    attemptId: String(input.attemptId),
    sourceRevision: input.sourceRevision,
    operation: "split",
    gameId: game.id,
    source: { path: input.source.rawFile, revision: input.sourceRevision },
    outputDirectory: input.outputDirectory,
    lapWindows,
  }, (message) => emitProgress(message.progress), signal);
}
