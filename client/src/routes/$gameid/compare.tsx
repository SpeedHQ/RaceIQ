import { createFileRoute, useSearch } from "@tanstack/react-router";
import { LapComparison } from "../../components/LapComparison";
import { validateCompareSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/compare")({
  component: ComparePage,
  validateSearch: validateCompareSearch,
});

function ComparePage() {
  const search = useSearch({ from: "/$gameid/compare" });
  return <LapComparison initialSearch={search} />;
}
