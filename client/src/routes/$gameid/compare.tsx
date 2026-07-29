import { createFileRoute, useSearch } from "@tanstack/react-router";
import { LapComparison, type LapComparisonSearch } from "../../components/LapComparison";

export const Route = createFileRoute("/$gameid/compare")({
  component: ComparePage,
  validateSearch: (search: Record<string, unknown>): LapComparisonSearch => ({
    track: search.track != null ? Number(search.track) : undefined,
    carA: search.carA ? Number(search.carA) : undefined,
    carB: search.carB ? Number(search.carB) : undefined,
    lapA: search.lapA ? Number(search.lapA) : undefined,
    lapB: search.lapB ? Number(search.lapB) : undefined,
  }),
});

function ComparePage() {
  const search = useSearch({ from: "/$gameid/compare" });
  return (
    <div className="h-full overflow-hidden">
      <LapComparison initialSearch={search} />
    </div>
  );
}
