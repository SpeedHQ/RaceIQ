/**
 * Main-thread client for the DB worker.
 * Provides async versions of expensive read-only queries
 * that run off the event loop so UDP/WS aren't blocked.
 */
import type { LapMeta, GameId } from "../../shared/types";
import { resolveDataDir } from "../data-dir";

let worker: Worker;
let msgId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

export function initDbWorker(): Promise<void> {
  worker = new Worker(new URL("./worker.ts", import.meta.url).href);

  worker.onmessage = (event: MessageEvent) => {
    const { id, result, error } = event.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  };

  const dbPath = `${resolveDataDir()}/forza-telemetry.db`;
  return send("init", { dbPath });
}

function send(type: string, params: Record<string, any> = {}): Promise<any> {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type, id, ...params });
  });
}

export function getLapsAsync(profileId?: number | null, gameId?: GameId, limit?: number): Promise<LapMeta[]> {
  return send("getLaps", { profileId, gameId, limit });
}
