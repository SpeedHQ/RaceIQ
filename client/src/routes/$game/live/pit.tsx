import { createFileRoute, redirect } from "@tanstack/react-router";
import { ForzaLiveDashboard } from "../../../components/ForzaLiveDashboard";
import { gameIdForRoutePrefix, liveDashboardForGame } from "../../../lib/game-routes";

export const Route = createFileRoute("/$game/live/pit")({
  beforeLoad: ({ params }) => {
    const gameId = gameIdForRoutePrefix(params.game);
    if (!gameId) throw new Error(`Unknown live game route prefix: ${params.game}`);
    if (liveDashboardForGame(gameId) !== "forza") {
      throw redirect({ to: "/$game/live", params: { game: params.game } });
    }
  },
  component: () => <ForzaLiveDashboard mode="pitcrew" />,
});
