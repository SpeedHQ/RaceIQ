import { existsSync } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { previewSessionCleanup, executeSessionCleanup, SessionCleanupBusyError } from "../../session-capture/session-cleanup";
import type { SessionCleanupRequest } from "../../../shared/racing/sessions/cleanup";

import { getAllGames } from "../../../shared/games/registry";
import { resolveDataDir } from "../../runtime/config/data-dir";

interface GameStorageStats {
  binCount: number;
  gzCount: number;
  binBytes: number;
  gzBytes: number;
}

const sessionCleanupRequestSchema: z.ZodType<SessionCleanupRequest> = z.union([
  z.object({ mode: z.literal("older-than"), olderThanDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(180), z.literal(365)]) }).strict(),
  z.object({ mode: z.literal("selected"), sessionIds: z.array(z.number().int().positive()) }).strict(),
]);

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
    let binCount = 0,
      gzCount = 0,
      binBytes = 0,
      gzBytes = 0;

    function tally(gameId: string, file: string, size: number) {
      let g = byGame[gameId];
      if (!g) {
        g = { binCount: 0, gzCount: 0, binBytes: 0, gzBytes: 0 };
        byGame[gameId] = g;
      }
      if (file.endsWith(".bin.gz")) {
        gzCount++;
        gzBytes += size;
        g.gzCount++;
        g.gzBytes += size;
      } else if (file.endsWith(".bin")) {
        binCount++;
        binBytes += size;
        g.binCount++;
        g.binBytes += size;
      }
    }

    const entries = await readdir(sessionsDir);
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(sessionsDir, entry);
        try {
          const entryStat = await stat(entryPath);
          if (entryStat.isDirectory()) {
            const files = await readdir(entryPath);
            await Promise.all(
              files.map(async (file) => {
                try {
                  const { size } = await stat(join(entryPath, file));
                  tally(entry, file, size);
                } catch {
                  /* skip */
                }
              }),
            );
          } else {
            // flat files pre-date per-game subdirs — skip
          }
        } catch {
          /* skip unreadable entries */
        }
      }),
    );

    let diskTotal = 0,
      diskFree = 0;
    try {
      const s = await statfs(sessionsDir);
      diskTotal = s.blocks * s.bsize;
      diskFree = s.bfree * s.bsize;
    } catch {
      /* statfs unavailable on some platforms */
    }
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
    const { runUserCompressionNow } = await import("../../session-capture/compressor");
    await runUserCompressionNow();
    return c.json({ ok: true });
  })
  .post("/api/storage/session-cleanup/preview", async (c) => {
    const parsed = sessionCleanupRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid cleanup request" }, 400);
    return c.json(await previewSessionCleanup(parsed.data));
  })
  .post("/api/storage/session-cleanup", async (c) => {
    const parsed = sessionCleanupRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid cleanup request" }, 400);
    try {
      return c.json(await executeSessionCleanup(parsed.data));
    } catch (err) {
      if (err instanceof SessionCleanupBusyError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });
