import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../../../../components/analyse/LapAnalyse";
import { gameIdForRoutePrefix, validateAnalyseSearch } from "../../../../../lib/game-routes";

function GameSessionReplayRoute() {
  const { gameid, sessionId, lapId } = Route.useParams();
  const gameId = gameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported replay route: ${gameid}`);
  return <LapAnalyse sessionId={Number(sessionId)} initialLapId={Number(lapId)} />;
}

export const Route = createFileRoute("/$gameid/sessions/$sessionId/replay/$lapId")({
  component: GameSessionReplayRoute,
  validateSearch: (search) => {
    const { cursor, viz, ai, view } = validateAnalyseSearch(search);
    return { cursor, viz, ai, view };
  },
});
