import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/analyse/LapAnalyse";
import { gameIdForRoutePrefix, validateAnalyseSearch } from "../../lib/game-routes";

function GameReplayRoute() {
  const { gameid } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported replay route: ${gameid}`);
  return <LapAnalyse />;
}

export const Route = createFileRoute("/$gameid/sessions/replay")({
  component: GameReplayRoute,
  validateSearch: validateAnalyseSearch,
});
