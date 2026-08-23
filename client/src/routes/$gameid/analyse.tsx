import { createFileRoute } from "@tanstack/react-router";
import { AnalyseRoute } from "@/components/tunes/review/AnalyseRoute";
import { gameIdForRoutePrefix, validateAnalyseSearch } from "../../lib/game-routes";

function GameAnalyseRoute() {
  const { gameid } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported Analyse route: ${gameid}`);
  return <AnalyseRoute gameId={gameId} />;
}

export const Route = createFileRoute("/$gameid/analyse")({
  component: GameAnalyseRoute,
  validateSearch: validateAnalyseSearch,
});
