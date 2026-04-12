import { createFileRoute } from "@tanstack/react-router";
import { LapComparison } from "../../components/LapComparison";

type CompareSearch = {
  track?: number;
  carA?: number;
  carB?: number;
  lapA?: number;
  lapB?: number;
};

export const Route = createFileRoute("/ac-evo/compare")({
  component: () => (
    <div className="h-full overflow-hidden">
      <LapComparison />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): CompareSearch => ({
    track: search.track ? Number(search.track) : undefined,
    carA: search.carA ? Number(search.carA) : undefined,
    carB: search.carB ? Number(search.carB) : undefined,
    lapA: search.lapA ? Number(search.lapA) : undefined,
    lapB: search.lapB ? Number(search.lapB) : undefined,
  }),
});
