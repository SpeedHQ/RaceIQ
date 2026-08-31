import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { AccLiveDashboard } from "../../components/acc/AccLiveDashboard";
import { ForzaLiveDashboard } from "../../components/ForzaLiveDashboard";
import { F1LiveDashboard } from "../../components/f1/F1LiveDashboard";
import { RadioDock } from "../../components/live-engineer/RadioDock";
import { gameIdForRoutePrefix, liveDashboardForGame } from "../../lib/game-routes";
import { gameStore } from "../../stores/game";

function LiveDashboardRoute() {
  const { game: routePrefix } = Route.useParams();
  const gameId = gameIdForRoutePrefix(routePrefix);
  const setGameId = gameStore.actions.setGameId;

  if (!gameId) throw new Error(`Unknown live game route prefix: ${routePrefix}`);
  useEffect(() => { setGameId(gameId); return () => setGameId(null); }, [gameId, setGameId]);

  const dashboard = (() => {
    switch (liveDashboardForGame(gameId)) {
      case "forza": return <ForzaLiveDashboard mode="driver" />;
      case "f1": return <F1LiveDashboard />;
      case "acc": return <AccLiveDashboard gameId={gameId} />;
    }
  })();
  return <div className="relative h-full"><RadioDock />{dashboard}</div>;
}

export const Route = createFileRoute("/$game/live")({
  beforeLoad: ({ params }) => { if (!gameIdForRoutePrefix(params.game)) throw new Error(`Unknown live game route prefix: ${params.game}`); },
  component: LiveDashboardRoute,
});
