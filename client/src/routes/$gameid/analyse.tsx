import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "@/components/analyse/LapAnalyse";
import { validateAnalyseSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/analyse")({
  component: LapAnalyse,
  validateSearch: validateAnalyseSearch,
});
