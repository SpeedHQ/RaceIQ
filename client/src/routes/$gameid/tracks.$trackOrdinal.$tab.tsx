import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "../../components/track/TrackDetailRoute";

function TrackTabRoute() {
  const { tab } = Route.useParams();
  return <TrackDetailRoute tab={tab} />;
}

export const Route = createFileRoute("/$gameid/tracks/$trackOrdinal/$tab")({
  component: TrackTabRoute,
});
