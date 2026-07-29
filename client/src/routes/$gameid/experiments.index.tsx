import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExperimentList } from "../../components/tunes/ExperimentList";
import { setupEngineerGameIdForRoutePrefix } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/experiments/")({
  component: ExperimentListRoute,
});

function ExperimentListRoute() {
  const { gameid } = Route.useParams();
  const gameId = setupEngineerGameIdForRoutePrefix(gameid);
  const navigate = useNavigate();
  if (!gameId) throw new Error(`Unsupported experiments route: ${gameid}`);
  return <ExperimentList gameId={gameId} onOpen={(id) => navigate({ to: "/$gameid/experiments/$experimentId", params: { gameid, experimentId: String(id) } })} />;
}
