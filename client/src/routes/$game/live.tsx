import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { gameIdForRoutePrefix } from "../../lib/game-routes";
import { gameStore } from "../../stores/game";

function LiveDashboardLayout() {
  const { game: routePrefix } = Route.useParams();
  const gameId = gameIdForRoutePrefix(routePrefix);
  const setGameId = gameStore.actions.setGameId;

  if (!gameId) {
    throw new Error(`Unknown live game route prefix: ${routePrefix}`);
  }

  useEffect(() => {
    setGameId(gameId);
    return () => setGameId(null);
  }, [gameId, setGameId]);

  return <Outlet />;
}

export const Route = createFileRoute("/$game/live")({
  beforeLoad: ({ params }) => {
    if (!gameIdForRoutePrefix(params.game)) {
      throw new Error(`Unknown live game route prefix: ${params.game}`);
    }
  },
  component: LiveDashboardLayout,
});
