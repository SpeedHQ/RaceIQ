import { createFileRoute } from "@tanstack/react-router";
import { TrackDetailRoute } from "../../components/track/TrackDetailRoute";

/**
 * Every non-index tab of a track: /f125/tracks/<ordinal>/<tab>.
 *
 * One dynamic segment rather than a file per tab — the tab set differs per
 * game, and TrackDetail already falls back to Info for a tab this game
 * doesn't have, so an unknown tab renders the track rather than a dead end.
 */
export const Route = createFileRoute("/f125/tracks/$trackOrdinal/$tab")({
  component: TrackTabRoute,
});

function TrackTabRoute() {
  const { tab } = Route.useParams();
  return <TrackDetailRoute tab={tab} />;
}
