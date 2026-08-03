import { type ReactNode, useLayoutEffect, useState } from "react";
import type { GameId } from "../../../shared/games/ids";
import { useGameStore } from "../stores/game";

export function GameStoryScope({ gameId, children }: { gameId: GameId; children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    useGameStore.getState().setGameId(gameId);
    setReady(true);

    return () => {
      const store = useGameStore.getState();
      if (store.gameId === gameId) store.setGameId(null);
    };
  }, [gameId]);

  return ready ? children : null;
}
