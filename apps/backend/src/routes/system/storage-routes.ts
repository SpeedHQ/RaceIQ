import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import os from "node:os";
import { resolveRecordingDirectory, resolveRecordingGameDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { getRecordingDirectoryMoveStatus, startRecordingDirectoryMove } from "@raceiq/backend-core/session-capture/relocate-recordings";
import { existsSync } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { previewSessionCleanup, executeSessionCleanup, SessionCleanupBusyError } from "@raceiq/backend-core/session-capture/session-cleanup";
import type { SessionCleanupRequest } from "@raceiq/shared/racing/sessions/cleanup";

import { getAllGames } from "@raceiq/shared/games/registry";

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
  .get("/api/storage/recording-directory", (c) => c.json(getRecordingDirectoryMoveStatus()))
  .post("/api/storage/recording-directory", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "INVALID_DIRECTORY", error: "Expected JSON body" }, 400); }
    const parsed = z.object({ directory: z.string() }).strict().safeParse(body);
    if (!parsed.success) return c.json({ code: "INVALID_DIRECTORY", error: "Expected absolute directory" }, 400);
    try {
      const result = await startRecordingDirectoryMove(parsed.data.directory);
      return c.json(result, result.noOp ? 200 : 202);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
      const http = code === "MOVE_ACTIVE" || code === "RECORDING_ACTIVE" || code === "IMPORT_ACTIVE" || code === "RECOVERY_REQUIRED" ? 409 : 400;
      return c.json({ code, error: error instanceof Error ? error.message : "Storage operation failed" }, http);
    }
  })
  .get("/api/storage/directories", async (c) => {
    const requested = c.req.query("path");
    let directory = requested ?? resolveRecordingDirectory();
    if (!isAbsolute(directory) || directory.includes("\0")) return c.json({ code: "INVALID_DIRECTORY", error: "Path must be absolute" }, 400);
    try {
      if (!requested) {
        while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
      }
      directory = await realpath(directory);
      if (!(await lstat(directory)).isDirectory()) return c.json({ code: "INVALID_DIRECTORY", error: "Path is not a directory" }, 400);
      const directories: { name: string; path: string }[] = [];
      for (const name of await readdir(directory)) {
        try {
          const path = resolvePath(directory, name);
          if ((await lstat(path)).isDirectory()) directories.push({ name, path: await realpath(path) });
        } catch { /* Skip inaccessible entries and symlinks. */ }
      }
      directories.sort((a, b) => a.name.localeCompare(b.name));
      const roots = process.platform === "win32"
        ? Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`).filter(existsSync)
        : ["/", os.homedir()];
      return c.json({ directory, parent: dirname(directory) === directory ? null : dirname(directory), roots, directories });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      return c.json({ code: code === "ENOENT" ? "DIRECTORY_NOT_FOUND" : code === "EACCES" ? "DIRECTORY_FORBIDDEN" : "STORAGE_IO_ERROR", error: code === "ENOENT" ? "Directory not found" : "Directory cannot be read" }, code === "ENOENT" ? 404 : code === "EACCES" ? 403 : 400);
    }
  })
  // GET /api/storage/sessions — recording file stats
  .get("/api/storage/sessions", async (c) => {
    const sessionsDir = resolveRecordingDirectory();
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

    const roots = [sessionsDir, resolveRecordingGameDirectory("", "mine"), resolveRecordingGameDirectory("", "others")];
    await Promise.all(roots.map(async (root) => {
      if (!existsSync(root)) return;
      let entries;
      try {
        if (root !== sessionsDir && !(await lstat(root)).isDirectory()) return;
        entries = await readdir(root, { withFileTypes: true });
      } catch {
        return;
      }
      await Promise.all(entries.map(async (entry) => {
        if (!entry.isDirectory() || (root === sessionsDir && (entry.name === "own" || entry.name === "others"))) return;
        const gameId = entry.name;
        const gamePath = join(root, gameId);
        let files;
        try {
          files = await readdir(gamePath, { withFileTypes: true });
        } catch {
          return;
        }
        await Promise.all(files.map(async (file) => {
          if (!file.isFile()) return;
          try {
            const { size } = await lstat(join(gamePath, file.name));
            tally(gameId, file.name, size);
          } catch {
            /* skip */
          }
        }));
      }));
    }));

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
    const { runUserCompressionNow } = await import("@raceiq/backend-core/session-capture/compressor");
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
