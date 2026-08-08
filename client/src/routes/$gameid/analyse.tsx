import { createFileRoute } from "@tanstack/react-router";
import { AnalyseRoute } from "@/components/tunes/review/AnalyseRoute";
import { useRequiredGameId } from "../../stores/game";
import { validateAnalyseSearch } from "../../lib/game-routes";

function AnalyseRoutePage() {
  const gameId = useRequiredGameId();
  return <AnalyseRoute gameId={gameId} />;
}

export const Route = createFileRoute("/$gameid/analyse")({
  component: AnalyseRoutePage,
  validateSearch: validateAnalyseSearch,
});
