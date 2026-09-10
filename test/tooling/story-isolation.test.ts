import { expect, test } from "bun:test";
import "../../client/src/stories/SessionsPage.stories";
import { gameStore, useGameStore } from "../../client/src/stores/game";
test("loading the sessions stories does not select a game globally", () => {
  expect(gameStore.get().gameId).toBeNull();
});
