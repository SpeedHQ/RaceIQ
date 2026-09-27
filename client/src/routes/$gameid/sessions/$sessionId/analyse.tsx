import { createFileRoute } from "@tanstack/react-router";
import { AnalyseRoute } from "@/components/tunes/review/AnalyseRoute";
import { gameIdForRoutePrefix, validateAnalyseSearch } from "../../../../lib/game-routes";

function GameSessionAnalyseRoute() {
  const { gameid, sessionId } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported Analyse route: ${gameid}`);
  const parsedSessionId = Number(sessionId);
  return <AnalyseRoute gameId={gameId} sessionId={parsedSessionId} />;
}

export const Route = createFileRoute("/$gameid/sessions/$sessionId/analyse")({
  component: GameSessionAnalyseRoute,
  validateSearch: validateAnalyseSearch,
});
