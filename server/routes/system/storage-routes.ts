import { existsSync } from "fs";
import { readdir, stat, statfs } from "fs/promises";
import { join, resolve } from "path";
import { Hono } from "hono";

import { getAllGames } from "../../../shared/games/registry";
import { resolveDataDir } from "../../runtime/config/data-dir";

interface GameStorageStats {
  binCount: number;
  gzCount: number;
  binBytes: number;
  gzBytes: number;
}

export const storageRoutes = new Hono()
  // GET /api/storage/sessions — recording file stats
  .get("/api/storage/sessions", async (c) => {
    const sessionsDir = resolve(resolveDataDir(), "sessions");
    const byGame: Record<string, GameStorageStats> = {};
    for (const game of getAllGames()) {
      byGame[game.id] = { binCount: 0, gzCount: 0, binBytes: 0, gzBytes: 0 };
    }
    if (!existsSync(sessionsDir)) {
      return c.json({ total: 0, binCount: 0, gzCount: 0, totalBytes: 0, binBytes: 0, gzBytes: 0, byGame, diskTotal: 0, diskFree: 0 });
    }
    let binCount = 0, gzCount = 0, binBytes = 0, gzBytes = 0;

    function tally(gameId: string, file: string, size: number) {
      const g = byGame[gameId] ??= { binCount: 0, gzCount: 0, binBytes: 0, gzBytes: 0 };
      if (file.endsWith(".bin.gz")) { gzCount++; gzBytes += size; g.gzCount++; g.gzBytes += size; }
      else if (file.endsWith(".bin")) { binCount++; binBytes += size; g.binCount++; g.binBytes += size; }
    }

    const entries = await readdir(sessionsDir);
    await Promise.all(entries.map(async (entry) => {
      const entryPath = join(sessionsDir, entry);
      try {
        const entryStat = await stat(entryPath);
        if (entryStat.isDirectory()) {
          const files = await readdir(entryPath);
          await Promise.all(files.map(async (file) => {
            try {
              const { size } = await stat(join(entryPath, file));
              tally(entry, file, size);
            } catch { /* skip */ }
          }));
        } else {
          // flat files pre-date per-game subdirs — skip
        }
      } catch { /* skip unreadable entries */ }
    }));

    let diskTotal = 0, diskFree = 0;
    try {
      const s = await statfs(sessionsDir);
      diskTotal = s.blocks * s.bsize;
      diskFree = s.bfree * s.bsize;
    } catch { /* statfs unavailable on some platforms */ }
    return c.json({
      total: binCount + gzCount,
      binCount,
      gzCount,
      totalBytes: binBytes + gzBytes,
      binBytes,
      gzBytes,
      byGame,
      diskTotal,
      diskFree,
    });
  })
  // POST /api/storage/compress — trigger immediate compression of eligible sessions
  .post("/api/storage/compress", async (c) => {
    console.log("[Compressor] User triggered compression");
    // Keep compressor lazy: this route must not start session maintenance at import time.
    const { runUserCompressionNow } = await import("../../session-capture/compressor");
    await runUserCompressionNow();
    return c.json({ ok: true });
  });
