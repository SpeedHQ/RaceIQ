import { createFileRoute } from "@tanstack/react-router";
import { ExperimentWorkspace } from "../../components/tunes/ExperimentWorkspace";
import { setupEngineerGameIdForRoutePrefix, validateTuneSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/experiments/$experimentId")({
  component: ExperimentWorkspaceRoute,
  validateSearch: validateTuneSearch,
});

function ExperimentWorkspaceRoute() {
  const { gameid, experimentId } = Route.useParams();
  const gameId = setupEngineerGameIdForRoutePrefix(gameid);
  if (!gameId) throw new Error(`Unsupported experiments route: ${gameid}`);
  return <ExperimentWorkspace gameId={gameId} experimentId={Number(experimentId)} />;
}
