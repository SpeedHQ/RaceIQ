import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "@raceiq/tracks-catalogue/ui"

function TrackTabRoute() {
  const { tab } = Route.useParams();
  return <TrackDetailRoute tab={tab} />;
}

export const Route = createFileRoute("/$gameid/tracks/$trackId/$tab")({
  component: TrackTabRoute,
});
