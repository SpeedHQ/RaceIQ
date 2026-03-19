import { createFileRoute } from "@tanstack/react-router";
import { LapComparison } from "../components/LapComparison";

type CompareSearch = {
  track?: number;
  carA?: number;
  carB?: number;
  lapA?: number;
  lapB?: number;
};

function ComparePage() {
  return (
    <div className="flex-1 overflow-hidden">
      <LapComparison />
    </div>
  );
}

export const Route = createFileRoute("/compare")({
  component: ComparePage,
  validateSearch: (search: Record<string, unknown>): CompareSearch => ({
    track: search.track ? Number(search.track) : undefined,
    carA: search.carA ? Number(search.carA) : undefined,
    carB: search.carB ? Number(search.carB) : undefined,
    lapA: search.lapA ? Number(search.lapA) : undefined,
    lapB: search.lapB ? Number(search.lapB) : undefined,
  }),
});
