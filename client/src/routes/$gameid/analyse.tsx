import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/LapAnalyse";
import { ResponsiveWorkspace } from "../../components/ResponsiveWorkspace";
import { validateAnalyseSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/analyse")({
  component: () => (
    <ResponsiveWorkspace>
      <LapAnalyse />
    </ResponsiveWorkspace>
  ),
  validateSearch: validateAnalyseSearch,
});
