import { createFileRoute } from "@tanstack/react-router";
import { SetupManagerPage } from "../../components/setup-manager/SetupManagerPage";
import { setupManagerGameIdForRoutePrefix } from "../../lib/game-routes";

function SetupManagerRoute() {
  const { gameid } = Route.useParams();
  const gameId = setupManagerGameIdForRoutePrefix(gameid);
  if (!gameId) return null;
  return <SetupManagerPage gameId={gameId} />;
}

export const Route = createFileRoute("/$gameid/setup-manager")({
  component: SetupManagerRoute,
  beforeLoad: ({ params }) => {
    if (!setupManagerGameIdForRoutePrefix(params.gameid)) throw new Error(`Setup manager unavailable for game: ${params.gameid}`);
  },
});
