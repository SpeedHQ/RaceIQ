import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miscRoutes } from "../../src/routes/system/index";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getAllGames } from "@raceiq/shared/games/registry";
import { existsSync } from "node:fs";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
initGameAdapters();

describe("session storage stats", () => {
  test("includes every registered game in byGame", async () => {
    const response = await miscRoutes.request("/api/storage/sessions");
    expect(response.status).toBe(200);

    const body = await response.json() as {
      byGame: Record<string, { binCount: number; gzCount: number; binBytes: number; gzBytes: number }>;
    };

    for (const game of getAllGames()) {
      expect(body.byGame[game.id]).toBeDefined();
      if (!existsSync(join(resolveDataDir(), "sessions", game.id))) {
        expect(body.byGame[game.id]).toEqual({
          binCount: 0,
          gzCount: 0,
          binBytes: 0,
          gzBytes: 0,
        });
      }
    }
  });

  test("tallies ownership and legacy folders against game ids", async () => {
    const root = resolveRecordingDirectory();
    const gameId = "storage-layout-test-game";
    const paths = [
      join(root, "own", gameId, "mine.bin"),
      join(root, "others", gameId, "other.bin.gz"),
      join(root, gameId, "legacy.bin"),
    ];
    try {
      for (const path of paths) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, Buffer.from("file"));
      }
      const response = await miscRoutes.request("/api/storage/sessions");
      const body = await response.json() as {
        byGame: Record<string, { binCount: number; gzCount: number; binBytes: number; gzBytes: number }>;
      };
      expect(body.byGame[gameId]).toEqual({ binCount: 2, gzCount: 1, binBytes: 8, gzBytes: 4 });
      expect(body.byGame.own).toBeUndefined();
      expect(body.byGame.others).toBeUndefined();
    } finally {
      await rm(join(root, "own", gameId), { recursive: true, force: true });
      await rm(join(root, "others", gameId), { recursive: true, force: true });
      await rm(join(root, gameId), { recursive: true, force: true });
    }
  });
});
