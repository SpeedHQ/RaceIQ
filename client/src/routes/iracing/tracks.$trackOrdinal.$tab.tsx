import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "../../components/track/TrackDetailRoute";

export const Route = createFileRoute("/iracing/tracks/$trackOrdinal/$tab")({
  component: TrackTabRoute,
});

function TrackTabRoute() {
  const { tab } = Route.useParams();
  return <TrackDetailRoute tab={tab} />;
}
