import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { getLayoutMigrationStatus, startLayoutMigration } from "../../session-capture/layout-migration";
import { getRecordingDirectoryMoveStatus, preflightRecordingDirectoryMove, startRecordingDirectoryMove } from "../../session-capture/relocate-recordings";
import { existsSync, type Dirent } from "node:fs";
import { readdir, statfs } from "node:fs/promises";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { pickRecordingFolder, RecordingFolderPickerError } from "../../runtime/platform/recording-folder-picker";
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
  .get("/api/storage/layout-migration", async (c) => c.json(await getLayoutMigrationStatus()))
  .post("/api/storage/layout-migration", zValidator("json", z.object({ directory: z.string().optional() }).strict(), (result, c) => {
    if (!result.success) return c.json({ code: "INVALID_DIRECTORY", error: "Invalid migration request" }, 400);
  }), async (c) => {
    const request = c.req.valid("json");
    try {
      await startLayoutMigration(request.directory);
      return c.json({ accepted: true }, 202);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
      const busy = ["MIGRATION_ACTIVE", "IMPORT_ACTIVE", "MOVE_ACTIVE", "RECORDING_ACTIVE", "LAYOUT_MIGRATION_PENDING", "STORAGE_OPERATION_BUSY"].includes(code);
      const invalid = ["INVALID_DIRECTORY", "DESTINATION_CONFLICT"].includes(code);
      const http = busy ? 409 : invalid ? 400 : 500;
      return c.json({ code, error: error instanceof Error ? error.message : "Layout migration failed" }, http);
    }
  })
  .get("/api/storage/recording-directory", (c) => c.json(getRecordingDirectoryMoveStatus()))
  .post("/api/storage/recording-directory/preflight", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "INVALID_DIRECTORY", error: "Expected JSON body" }, 400); }
    const parsed = z.object({ directory: z.string() }).strict().safeParse(body);
    if (!parsed.success) return c.json({ code: "INVALID_DIRECTORY", error: "Expected absolute directory" }, 400);
    try { return c.json(await preflightRecordingDirectoryMove(parsed.data.directory)); }
    catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "STORAGE_IO_ERROR";
      return c.json({ code, error: error instanceof Error ? error.message : "Storage preflight failed" }, 400);
    }
  })
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
      const http = code === "MOVE_ACTIVE" || code === "RECORDING_ACTIVE" || code === "IMPORT_ACTIVE" || code === "RECOVERY_REQUIRED" || code === "LAYOUT_MIGRATION_PENDING" ? 409 : 400;
      return c.json({ code, error: error instanceof Error ? error.message : "Storage operation failed" }, http);
    }
  })
  .post("/api/storage/select-directory", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ code: "INVALID_DIRECTORY", error: "Expected JSON body" }, 400); }
    const parsed = z.object({ directory: z.string().optional() }).strict().safeParse(body);
    if (!parsed.success) return c.json({ code: "INVALID_DIRECTORY", error: "Invalid folder picker request" }, 400);
    try {
      return c.json({ directory: await pickRecordingFolder(parsed.data.directory ?? resolveRecordingDirectory()) });
    } catch (error) {
      const code = error instanceof RecordingFolderPickerError ? error.code : "PICKER_FAILED";
      const status = code === "PICKER_ACTIVE" ? 409 : code === "INVALID_DIRECTORY" ? 400 : 500;
      return c.json({ code, error: error instanceof Error ? error.message : "Folder picker failed" }, status);
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

    let games: Dirent[];
    try {
      games = await readdir(sessionsDir, { withFileTypes: true });
    } catch {
      games = [];
    }
    await Promise.all(games.map(async (game) => {
      if (!game.isDirectory() || game.name === "own" || game.name === "others") return;
      const gameId = game.name;
      const gamePath = join(sessionsDir, gameId);
      let entries;
      try {
        entries = await readdir(gamePath, { withFileTypes: true });
      } catch {
        return;
      }
      const captureDirectories = [{ path: gamePath, files: entries.filter((entry) => entry.isFile()) }];
      for (const ownership of entries) {
        if (!ownership.isDirectory() || (ownership.name !== "own" && ownership.name !== "others")) continue;
        const ownershipPath = join(gamePath, ownership.name);
        try {
          const files = await readdir(ownershipPath, { withFileTypes: true });
          captureDirectories.push({ path: ownershipPath, files: files.filter((file) => file.isFile()) });
        } catch {
          /* skip */
        }
      }
      await Promise.all(captureDirectories.flatMap(({ path, files }) => files.map(async (file) => {
        try {
          const { size } = await lstat(join(path, file.name));
          tally(gameId, file.name, size);
        } catch {
          /* skip */
        }
      })));
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
