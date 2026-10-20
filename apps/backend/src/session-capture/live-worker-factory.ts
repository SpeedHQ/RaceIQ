import { Worker, type WorkerOptions } from "node:worker_threads";
import type { GameId } from "@raceiq/shared/games/ids";

/** Prefer Bun's small-heap GC policy for background recording and verification. */
export function createLiveCaptureWorker(gameId: GameId): Worker {
  const options: WorkerOptions & Bun.WorkerOptions = { workerData: { gameId }, smol: true };
  return new Worker(new URL("./live-worker-entry.ts", import.meta.url), options);
}
