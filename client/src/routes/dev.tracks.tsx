import { createFileRoute } from "@tanstack/react-router";
import { TrackWorkbenchLayout } from "../components/dev/tracks/TrackWorkbenchLayout";

export const Route = createFileRoute("/dev/tracks")({
  component: TrackWorkbenchLayout,
});
