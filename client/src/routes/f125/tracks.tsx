import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../../components/TrackViewer";

type TracksSearch = {
  track?: number;
  tab?: string;
  setup?: string;
  subtab?: string;
};

export const Route = createFileRoute("/f125/tracks")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <TrackViewer />
    </div>
  ),
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track != null && search.track !== "" ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
    setup: typeof search.setup === "string" ? search.setup : undefined,
    subtab: typeof search.subtab === "string" ? search.subtab : undefined,
  }),
});
