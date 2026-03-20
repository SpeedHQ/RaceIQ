import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../components/LapAnalyse";

type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
};

function AnalysePage() {
  return (
    <div className="h-full overflow-hidden">
      <LapAnalyse />
    </div>
  );
}

export const Route = createFileRoute("/analyse")({
  component: AnalysePage,
  validateSearch: (search: Record<string, unknown>): AnalyseSearch => ({
    track: search.track ? Number(search.track) : undefined,
    car: search.car ? Number(search.car) : undefined,
    lap: search.lap ? Number(search.lap) : undefined,
  }),
});
