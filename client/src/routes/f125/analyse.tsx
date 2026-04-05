import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../../components/LapAnalyse";

type AnalyseSearch = {
  track?: number;
  car?: number;
  lap?: number;
  cursor?: number;
  viz?: string;
};

export const Route = createFileRoute("/f125/analyse")({
  component: () => (
    <div className="h-full overflow-hidden">
      <LapAnalyse />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): AnalyseSearch => ({
    track: search.track ? Number(search.track) : undefined,
    car: search.car ? Number(search.car) : undefined,
    lap: search.lap ? Number(search.lap) : undefined,
    cursor: search.cursor ? Number(search.cursor) : undefined,
    viz: typeof search.viz === "string" ? search.viz : undefined,
  }),
});
