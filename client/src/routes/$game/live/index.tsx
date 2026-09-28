import { createFileRoute } from "@tanstack/react-router";
import { AccLiveDashboard } from "../../../components/acc/AccLiveDashboard";
import { LMULiveDashboard } from "../../../components/lmu/LMULiveDashboard";
import { ForzaLiveDashboard } from "../../../components/ForzaLiveDashboard";
import { F1LiveDashboard } from "../../../components/f1/F1LiveDashboard";
import { gameIdForRoutePrefix, liveDashboardForGame } from "../../../lib/game-routes";

function LiveDashboardIndex() {
  const { game: routePrefix } = Route.useParams();
  const gameId = gameIdForRoutePrefix(routePrefix);
  if (!gameId) throw new Error(`Unknown live game route prefix: ${routePrefix}`);

  switch (liveDashboardForGame(gameId)) {
    case "forza":
      return <ForzaLiveDashboard mode="driver" />;
    case "f1":
      return <F1LiveDashboard />;
    case "acc":
      return <AccLiveDashboard gameId={gameId} />;
    case "lmu":
      return <LMULiveDashboard />;
  }
}

export const Route = createFileRoute("/$game/live/")({
  component: LiveDashboardIndex,
});
