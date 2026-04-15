import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = {
  track?: number;
  tab?: string;
};

export const Route = createFileRoute("/fm23/tracks")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <TrackViewer />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track != null && search.track !== "" ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
});
