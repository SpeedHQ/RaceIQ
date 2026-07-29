import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "../../components/track/TrackDetailRoute";

export const Route = createFileRoute("/iracing/tracks/$trackOrdinal/")({
  component: () => <TrackDetailRoute tab="info" />,
});
