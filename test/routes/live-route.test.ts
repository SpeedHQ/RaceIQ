import { describe, expect, test } from "bun:test";
import { initGameAdapters } from "../../shared/games/init";
import { getAllGames } from "../../shared/games/registry";
import { liveDashboardForGame, resolveLiveGameId } from "../../client/src/routes/$game/live";

initGameAdapters();

describe("live route game resolution", () => {
  test("resolves every registered route prefix to its game id", () => {
    for (const game of getAllGames()) {
      expect(resolveLiveGameId(game.routePrefix)).toBe(game.id);
    }
  });

  test("rejects unknown route prefixes without an FM fallback", () => {
    expect(resolveLiveGameId("unknown-game")).toBeUndefined();
    expect(resolveLiveGameId("")).toBeUndefined();
  });
});

describe("live route dashboard dispatch", () => {
  test("selects the existing dashboard for each registered game", () => {
    expect(liveDashboardForGame("fm-2023")).toBe("forza");
    expect(liveDashboardForGame("f1-2025")).toBe("f1");
    expect(liveDashboardForGame("acc")).toBe("acc");
    expect(liveDashboardForGame("ac-evo")).toBe("acc");
  });
});
