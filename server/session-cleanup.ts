/**
 * Boot-time cleanup for orphan session recording files.
 *
 * Two passes:
 *   1. Tiny orphans — files <= 12 bytes (just the meta-frame header). Left
 *      behind by sessions that opened a recorder but received no packets.
 *   2. Untracked orphans — .bin / .bin.gz files not referenced by any
 *      sessions.rawFile. Empty sessions get pruned by deleteEmptySessions(),
 *      which now unlinks its own file, but historical orphans (deleted rows,
 *      failed compressions) need this sweep.
 */
import { readdir, stat, unlink } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join } from "path";
import { resolveDataDir } from "./data-dir";
import { db } from "./db/index";
import { sessions } from "./db/schema";
import { sql } from "drizzle-orm";
import { isSessionActive } from "./pipeline";

const TINY_ORPHAN_THRESHOLD_BYTES = 12;

async function loadReferencedRawFiles(): Promise<Set<string>> {
  const rows = await db
    .select({ rawFile: sessions.rawFile })
    .from(sessions)
    .where(sql`${sessions.rawFile} IS NOT NULL`)
    .all();
  return new Set(rows.map((r) => r.rawFile).filter((p): p is string => !!p));
}

export async function cleanupOrphanSessionFiles(): Promise<number> {
  if (isSessionActive()) {
    console.log("[Cleanup] Session active — skipping orphan sweep");
    return 0;
  }

  const sessionsDir = resolve(resolveDataDir(), "sessions");
  if (!existsSync(sessionsDir)) return 0;

  const referenced = await loadReferencedRawFiles();

  let removed = 0;
  const gameDirs = await readdir(sessionsDir);
  for (const gameDir of gameDirs) {
    const dirPath = join(sessionsDir, gameDir);
    try {
      if (!(await stat(dirPath)).isDirectory()) continue;
    } catch { continue; }

    const files = await readdir(dirPath);
    for (const file of files) {
      if (!file.endsWith(".bin") && !file.endsWith(".bin.gz")) continue;
      const filePath = join(dirPath, file);
      try {
        const { size } = await stat(filePath);
        const isTiny = file.endsWith(".bin") && size <= TINY_ORPHAN_THRESHOLD_BYTES;
        const isUntracked = !referenced.has(filePath);
        if (isTiny || isUntracked) {
          await unlink(filePath);
          removed++;
        }
      } catch {
        // Skip unreadable / concurrently-removed entries
      }
    }
  }
  return removed;
}
