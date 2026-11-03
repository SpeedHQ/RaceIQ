import { createFileRoute } from "@tanstack/react-router";
import { AnalyseRoute } from "@raceiq/session-analyse/ui";
import { validateAnalyseSearch } from "@raceiq/session-analyse/contracts";
import { gameIdForRoutePrefix } from "../../lib/game-routes";

function GameAnalyseRoute() {
  const { gameid } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported Analyse route: ${gameid}`);
  return <AnalyseRoute gameId={gameId} />;
}

export const Route = createFileRoute("/$gameid/sessions/analyse")({
  component: GameAnalyseRoute,
  validateSearch: validateAnalyseSearch,
});
