import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "@raceiq/tracks-catalogue/ui"

export const Route = createFileRoute("/$gameid/tracks/$trackId/")({
  component: () => <TrackDetailRoute tab="info" />,
});
