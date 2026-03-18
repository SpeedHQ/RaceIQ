import { createFileRoute } from "@tanstack/react-router";
import { TrackViewer } from "../components/TrackViewer";

function TracksPage() {
  return (
    <div className="flex-1 overflow-auto">
      <TrackViewer />
    </div>
  );
}

export const Route = createFileRoute("/tracks")({
  component: TracksPage,
});
