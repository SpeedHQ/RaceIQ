import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { gameIdForRoutePrefix } from "../lib/game-routes";
import { gameStore, } from "../stores/game";

function DynamicGameLayout() {
  const { gameid } = useParams({ from: "/$gameid" });
  const setGameId = gameStore.actions.setGameId;
  const gameId = gameIdForRoutePrefix(gameid);

  useEffect(() => {
    setGameId(gameId ?? null);
    return () => setGameId(null);
  }, [gameId, setGameId]);

  return <Outlet />;
}

export const Route = createFileRoute("/$gameid")({
  beforeLoad: ({ params }) => {
    if (!gameIdForRoutePrefix(params.gameid)) {
      throw new Error(`Unknown game route prefix: ${params.gameid}`);
    }
  },
  component: DynamicGameLayout,
});
