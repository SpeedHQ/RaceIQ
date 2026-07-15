import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "../../components/track/TrackDetailRoute";

/** A track's index route is its Info view — the reference data for the track. */
export const Route = createFileRoute("/fm23/tracks/$trackOrdinal/")({
  component: () => <TrackDetailRoute tab="info" />,
});
