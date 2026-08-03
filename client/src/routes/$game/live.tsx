import { getAllGames } from "@shared/games/registry";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import type { GameId } from "../../../../shared/games/ids";
import { AccLiveDashboard } from "../../components/acc/AccLiveDashboard";
import { ForzaLiveDashboard } from "../../components/ForzaLiveDashboard";
import { F1LiveDashboard } from "../../components/f1/F1LiveDashboard";
import { useGameStore } from "../../stores/game";

export type LiveDashboard = "forza" | "f1" | "acc";

/** Resolve a URL game segment through the registered game adapters. */
export function resolveLiveGameId(routePrefix: string): GameId | undefined {
  return getAllGames().find((game) => game.routePrefix === routePrefix)?.id;
}

/** Select the existing dashboard implementation for a registered game. */
export function liveDashboardForGame(gameId: GameId): LiveDashboard {
  switch (gameId) {
    case "fm-2023":
      return "forza";
    case "f1-2025":
      return "f1";
    case "acc":
    case "ac-evo":
      return "acc";
    default:
      throw new Error(`Unsupported live dashboard game: ${gameId}`);
  }
}

function LiveDashboardRoute() {
  const { game: routePrefix } = Route.useParams();
  const gameId = resolveLiveGameId(routePrefix);
  const setGameId = useGameStore((state) => state.setGameId);

  if (!gameId) {
    throw new Error(`Unknown live game route prefix: ${routePrefix}`);
  }

  useEffect(() => {
    setGameId(gameId);
    return () => setGameId(null);
  }, [gameId, setGameId]);

  switch (liveDashboardForGame(gameId)) {
    case "forza":
      return <ForzaLiveDashboard mode="driver" />;
    case "f1":
      return <F1LiveDashboard />;
    case "acc":
      return <AccLiveDashboard gameId={gameId} />;
  }
}

export const Route = createFileRoute("/$game/live")({
  beforeLoad: ({ params }) => {
    if (!resolveLiveGameId(params.game)) {
      throw new Error(`Unknown live game route prefix: ${params.game}`);
    }
  },
  component: LiveDashboardRoute,
});
