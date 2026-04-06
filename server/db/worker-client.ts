/**
 * Async query helpers.
 *
 * TODO: migrate from bun:sqlite (synchronous) to an async SQLite adapter
 * (e.g. @libsql/client) so heavy queries don't block the event loop.
 * For now, queries run on the main thread.
 */
import type { LapMeta, GameId } from "../../shared/types";

export async function initDbWorker(): Promise<void> {
  // No-op — worker removed. Queries run on main thread until async adapter migration.
}

export function getLapsAsync(profileId?: number | null, gameId?: GameId, limit?: number): Promise<LapMeta[]> {
  const { getLaps } = require("./queries") as typeof import("./queries");
  return Promise.resolve(getLaps(profileId, gameId, limit));
}
