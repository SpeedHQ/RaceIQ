import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/LapAnalyse";
import { validateAnalyseSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/analyse")({
  component: () => (
    <div className="h-full overflow-hidden">
      <LapAnalyse />
    </div>
  ),
  validateSearch: validateAnalyseSearch,
});
