import { createFileRoute, useParams } from "@tanstack/react-router";
import { parseDevTrackIdentity } from "../lib/dev-track-routes";
import { TrackImageryCalibrationPanel } from "../components/dev/TrackImageryCalibrationPanel";
import { useTrackWorkbenchContext } from "../components/dev/tracks/TrackWorkbenchLayout";

function ImageryRoute() {
  const params = useParams({ from: "/dev/tracks/$gameId/$trackOrdinal" });
  const { gameId, trackOrdinal } = parseDevTrackIdentity(params);
  const { configurationRevision } = useTrackWorkbenchContext();
  return <TrackImageryCalibrationPanel selection={{ gameId, trackOrdinal }} configurationRevision={configurationRevision} />;
}

export const Route = createFileRoute("/dev/tracks/$gameId/$trackOrdinal/imagery")({
  beforeLoad: ({ params }) => {
    parseDevTrackIdentity(params);
  },
  component: ImageryRoute,
});
