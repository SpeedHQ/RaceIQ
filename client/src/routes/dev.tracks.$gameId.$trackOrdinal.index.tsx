import { createFileRoute, useParams } from "@tanstack/react-router";
import { parseDevTrackIdentity } from "../lib/dev-track-routes";
import { TrackWorkbenchOverview } from "../components/dev/tracks/TrackWorkbenchOverview";

function OverviewRoute() {
  const params = useParams({ from: "/dev/tracks/$gameId/$trackOrdinal" });
  const { gameId, trackOrdinal } = parseDevTrackIdentity(params);
  return <TrackWorkbenchOverview gameId={gameId} trackOrdinal={trackOrdinal} />;
}

export const Route = createFileRoute("/dev/tracks/$gameId/$trackOrdinal/")({
  component: OverviewRoute,
});
