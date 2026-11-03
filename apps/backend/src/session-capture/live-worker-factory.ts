import { Worker, type WorkerOptions } from "node:worker_threads";
import type { GameId } from "@raceiq/shared/games/ids";

/** Prefer Bun's small-heap GC policy for background recording and verification. */
export function createLiveCaptureWorker(gameId: GameId): Worker {
  const options: WorkerOptions & Bun.WorkerOptions = { workerData: { gameId }, smol: true };
  const compiled = import.meta.dir.startsWith("/$bunfs") || import.meta.dir.includes("~BUN");
  return new Worker(compiled ? "./apps/backend/src/session-capture/live-worker-entry.ts" : new URL("./live-worker-entry.ts", import.meta.url), options);
}
