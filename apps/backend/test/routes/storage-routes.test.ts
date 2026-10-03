import { describe, expect, test } from "bun:test";
import { miscRoutes } from "../../src/routes/system/index";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { getAllGames } from "@raceiq/shared/games/registry";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";

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
});
