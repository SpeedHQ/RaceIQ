import { type ReactNode, useLayoutEffect, useState } from "react";
import type { GameId } from "../../../shared/games/ids";
import { gameStore } from "../stores/game";

export function GameStoryScope({ gameId, children }: { gameId: GameId; children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    gameStore.actions.setGameId(gameId);
    setReady(true);

    return () => {
      const store = gameStore.get();
      if (store.gameId === gameId) gameStore.actions.setGameId(null);
    };
  }, [gameId]);

  return ready ? children : null;
}
