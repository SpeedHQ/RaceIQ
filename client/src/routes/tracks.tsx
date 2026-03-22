import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../components/TrackViewer";

type TracksSearch = {
  track?: number;
  tab?: string;
};

function TracksPage() {
  return (
    <div className="flex-1 overflow-auto">
      <TrackViewer />
    </div>
  );
}

export const Route = createFileRoute("/tracks")({
  component: TracksPage,
  validateSearch: (search: Record<string, unknown>): TracksSearch => ({
    track: search.track ? Number(search.track) : undefined,
    tab: typeof search.tab === "string" ? search.tab : undefined,
  }),
});
