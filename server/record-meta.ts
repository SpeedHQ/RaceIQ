import { writeFileSync, renameSync, mkdirSync, existsSync } from "fs";
import { resolve } from "path";
import type { GameId } from "../shared/types";

export interface RecordingMeta {
  gameId: GameId;
  trackOrdinal: number | null;
  trackName: string | null;
  carOrdinal: number | null;
  carName: string | null;
  startedAt: string;
}

/**
 * Write meta.json atomically to sessionDir using write-to-tmp + rename.
 * Safe to call multiple times as metadata is resolved; each call overwrites.
 */
export function writeRecordingMeta(sessionDir: string, meta: RecordingMeta): void {
  if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });
  const tmpPath = resolve(sessionDir, "meta.tmp");
  const finalPath = resolve(sessionDir, "meta.json");
  writeFileSync(tmpPath, JSON.stringify(meta, null, 2), "utf-8");
  renameSync(tmpPath, finalPath);
}
