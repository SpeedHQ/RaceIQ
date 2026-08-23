import { createFileRoute, useParams } from "@tanstack/react-router";
import { parseDevTrackIdentity } from "../lib/dev-track-routes";
import { TrackGuideEditor } from "../components/dev/tracks/TrackGuideEditor";

function GuidesRoute() {
  const params = useParams({ from: "/dev/tracks/$gameId/$trackOrdinal" });
  const { gameId, trackOrdinal } = parseDevTrackIdentity(params);
  return <TrackGuideEditor gameId={gameId} trackOrdinal={trackOrdinal} />;
}

export const Route = createFileRoute("/dev/tracks/$gameId/$trackOrdinal/guides")({
  beforeLoad: ({ params }) => {
    parseDevTrackIdentity(params);
  },
  component: GuidesRoute,
});
